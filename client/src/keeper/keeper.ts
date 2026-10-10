import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { type Interface, Wallet, type JsonRpcProvider, type Signer } from 'ethers';
import {
    catchError,
    combineLatest,
    concatMap,
    defer,
    EMPTY,
    exhaustMap,
    filter,
    finalize,
    from,
    ignoreElements,
    map,
    merge,
    mergeMap,
    type Observable,
    of,
    pairwise,
    scan,
    startWith,
    switchMap,
    take,
    takeWhile,
    tap,
    timer,
} from 'rxjs';
import { NoriSnapshot__factory } from '@nori-zk/ethereum-snapshot';
import {
    NoriProofRequestQueue__factory,
    NoriTokenBridge__factory,
    PAUSE_STATE_PAUSED,
    PAUSE_STATE_UNPAUSED,
} from '@nori-zk/ethereum-tempo-bridge';
import {
    changesOf$,
    createChainChangesMachine,
    type ChainChanges,
    createBridgeStateMachine,
    createConnections,
    createProofQueueHeadMachine,
    createSignerTransactionMachine,
    type ConnectionName,
    type Connections,
    type TransactionCall,
} from '@nori-zk/nori-bridge-tempo-sdk';
import { Backstop__factory, ReadKind } from '@nori-zk/tempo-backstop';
import { guardStatusName } from '../backstop.js';
import { guardConfigOf, queryOf, type GuardEntry, type KeeperConfig, type MirrorEntry } from './config.js';
import { createFeeMachine } from './fee.impl.js';
import { type GuardState } from './guard.js';
import { createGuardMachine } from './guard.impl.js';
import { type MirrorPauseState } from './mirrorPause.js';
import { createMirrorPauseMachine } from './mirrorPause.impl.js';
import { type PauseApplicationState } from './pauseApplication.js';
import { createPauseApplicationMachine } from './pauseApplication.impl.js';
import {
    keepSending,
    type SendLost,
    sendLost,
    sendLostReason,
    type SendOver,
    sendOutcomeOf,
    sendOver,
} from './sends.js';
import { type SnapshotSubmissionState } from './snapshotSubmission.js';
import { createSnapshotSubmissionMachine, type GuardRead } from './snapshotSubmission.impl.js';
import { createProvider } from './tempo.js';

// Contract errors the keeper treats as "nothing to do"
const READ_NOT_NEWER = 'ReadNotNewer';
const CHECKPOINT_TOO_SOON = 'CheckpointTooSoon';
const PAUSE_NOT_NEWER = 'PauseNotNewer';

// The ABIs the keeper's calls are encoded with, and refusals named by
const backstopInterface = Backstop__factory.createInterface();
const noriSnapshotInterface = NoriSnapshot__factory.createInterface();
const noriTokenBridgeInterface = NoriTokenBridge__factory.createInterface();

/** A `syncPause` transaction whose proof is not applied on Tempo yet. */
interface PendingPause {
    name: string;
    ethToken: string;
    syncPauseTxHash: string;
}

interface KeeperState {
    /** Snapshot transactions whose reads are not all submitted yet. */
    pending: string[];
    /** Pause syncs whose proof is not applied to the mirror yet. */
    pausesPending: PendingPause[];
}

/** How a send ended: over (mined or refused by the contract, `outcome`), or failed to send (`failed`). */
type SendEnd = { outcome: string } | { failed: string };

/** A running machine, as far as reading its states and closing it go. */
interface Running<TState> {
    state$: Observable<TState>;
    close(): void;
}

/**
 * Each `current` value a read machine holds, as it changes.
 *
 * @param machine A machine built on `readThroughConnectionsOf`.
 * @returns Its `current` data, each time it is current.
 */
function currentData$<TState extends { node: string; data: unknown }>(
    machine: Running<TState>
): Observable<Extract<TState, { node: 'current' }>['data']> {
    return machine.state$.pipe(
        filter((state): state is Extract<TState, { node: 'current' }> => state.node === 'current'),
        map(({ data }) => data)
    );
}

/**
 * The first `current` value a read machine holds, for a one-off command;
 * the machine is closed once it is read.
 *
 * @param machine A machine built on `readThroughConnectionsOf`.
 * @returns Its `current` data, once.
 */
function currentOf$<TState extends { node: string; data: unknown }>(
    machine: Running<TState>
): Observable<Extract<TState, { node: 'current' }>['data']> {
    return currentData$(machine).pipe(
        take(1),
        finalize(() => machine.close())
    );
}

/**
 * Each item of a list in the state file not seen before, re-reading the
 * file every interval: what another keeper process added is picked up too.
 *
 * @param items$ The list, each time the file is read.
 * @param keyOf An item's key.
 * @returns Each new item, once.
 */
function newItems$<T>(items$: Observable<T[]>, keyOf: (item: T) => string): Observable<T> {
    return items$.pipe(
        scan(
            ({ seen }, items) => {
                const fresh = items.filter((item) => !seen.has(keyOf(item)));
                return { seen: new Set([...seen, ...fresh.map(keyOf)]), fresh };
            },
            { seen: new Set<string>(), fresh: [] as T[] }
        ),
        concatMap(({ fresh }) => from(fresh))
    );
}

export class Keeper {
    /** Each log of the Tempo bridge, a committed batch among them: what makes a proof request worth reading again. */
    private readonly bridgeLogs: ChainChanges;

    private constructor(
        private readonly config: KeeperConfig,
        private readonly connections: Connections,
        private readonly tempoSigner: Wallet,
        private readonly ethereumProvider: JsonRpcProvider
    ) {
        this.bridgeLogs = createChainChangesMachine(connections.tempo, { address: config.tempo.bridge });
    }

    /** The keeper signs through its own signers and reads through the sdk's connections. */
    static connect(config: KeeperConfig): Keeper {
        const key = process.env.TEMPO_PRIVATE_KEY;
        if (!key) throw new Error('Missing env: TEMPO_PRIVATE_KEY');
        const connections = createConnections({
            ethereum: { expectedChainId: BigInt(config.ethereum.chainId), http: { rpcUrl: config.ethereum.rpcUrl } },
            tempo: { expectedChainId: BigInt(config.tempo.chainId), http: { rpcUrl: config.tempo.rpcUrl } },
        });
        return new Keeper(
            config,
            connections,
            new Wallet(key, createProvider(config.tempo.rpcUrl)),
            createProvider(config.ethereum.rpcUrl)
        );
    }

    /** Closes the keeper's connections. */
    close() {
        this.bridgeLogs.close();
        this.connections.close();
    }

    private log(message: string) {
        console.log(`${new Date().toISOString()} ${message}`);
    }

    /** The Ethereum signer of snapshots and pause syncs. */
    private ethereumSigner(): Wallet {
        const key = process.env.ETH_PRIVATE_KEY;
        if (!key) throw new Error('Missing env: ETH_PRIVATE_KEY');
        return new Wallet(key, this.ethereumProvider);
    }

    private tokenBridgeAddress(): string {
        const { tokenBridge } = this.config.ethereum;
        if (!tokenBridge)
            throw new Error('Missing config: ethereum.tokenBridge (the NoriTokenBridge), needed with mirrors');
        return tokenBridge;
    }

    private loadState(): KeeperState {
        return {
            pending: [],
            pausesPending: [],
            ...(existsSync(this.config.stateFile)
                ? (JSON.parse(readFileSync(this.config.stateFile, 'utf8')) as Partial<KeeperState>)
                : {}),
        };
    }

    /** Applies `change` to the state file as it is now, so what another keeper process added is kept. */
    private updateState(change: (state: KeeperState) => KeeperState) {
        writeFileSync(this.config.stateFile, JSON.stringify(change(this.loadState()), null, 2) + '\n');
    }

    /** Signals to read a proof request again: each log of the Tempo bridge, a committed batch among them. */
    private bridgeChanged$() {
        return changesOf$(this.bridgeLogs);
    }

    /**
     * Whether the Nori bridge is there: its state machine's first read lands
     * `current`, or fails (no contract to read). While a connection is down
     * it waits for it.
     *
     * @returns Whether its state can be read, once.
     */
    private bridgeReadable$(): Observable<boolean> {
        return defer(() => {
            const bridgeState = createBridgeStateMachine(this.connections, this.config.tempo.bridge);
            return bridgeState.state$.pipe(
                filter((state) => state.node === 'current' || state.node === 'failedWhileLoading'),
                take(1),
                map((state) => state.node === 'current'),
                finalize(() => bridgeState.close())
            );
        });
    }

    /**
     * One transaction sent with a signer of the keeper's, made for the call
     * `call$` gives and sent at once, until it is mined, refused by the
     * contract, or ends without the chain's verdict. A call that cannot be
     * made (a read it needs failed) fails to send.
     *
     * @param chain The chain it is sent on.
     * @param signer The keeper's signer there.
     * @param call$ The call: the contract, its data and the value, once.
     * @param errors The contract's error ABI, to name a refusal.
     * @param sent Called once with its hash when it is sent.
     * @returns How it ended, once.
     */
    private send$(
        chain: ConnectionName,
        signer: Signer,
        call$: Observable<TransactionCall>,
        errors: Interface,
        sent: (hash: string) => void = () => undefined
    ): Observable<SendEnd> {
        return call$.pipe(
            take(1),
            map((call) => ({ call })),
            catchError((error: unknown) => of({ cannotMake: error instanceof Error ? error.message : String(error) })),
            switchMap((made): Observable<SendEnd> => {
                if ('cannotMake' in made) return of({ failed: made.cannotMake });
                const transaction = createSignerTransactionMachine(this.connections, chain, signer, made.call, {
                    errors,
                });
                // Sent on each entry into `ready`: at once, and again once a connection still
                // being checked is usable (`notReadyToSend` moves back to `ready` by itself).
                const sending = keepSending(of([transaction]), this.config.intervals.pollSecs * 1000);
                return merge(
                    transaction.state$.pipe(
                        map((state) => ('transactionHash' in state.data ? state.data.transactionHash : '')),
                        filter((hash) => hash !== ''),
                        take(1),
                        tap(sent),
                        ignoreElements()
                    ),
                    transaction.state$.pipe(
                        filter(
                            (state): state is SendOver | SendLost =>
                                sendOver(state) || (sendLost(state) && state.node !== 'notReadyToSend')
                        ),
                        take(1),
                        map((state): SendEnd =>
                            sendOver(state) ? { outcome: sendOutcomeOf(state) } : { failed: sendLostReason(state) }
                        )
                    )
                ).pipe(
                    take(1),
                    finalize(() => {
                        sending.unsubscribe();
                        transaction.close();
                    })
                );
            })
        );
    }

    /** One guard's machine. */
    private guardMachine(guard: GuardEntry) {
        return createGuardMachine(
            this.connections,
            this.config.tempo.backstop,
            guard.token,
            this.tempoSigner.address,
            this.config.intervals.pollSecs * 1000
        );
    }

    /** One mirror's pause state machine. */
    private mirrorPauseMachine(mirror: MirrorEntry) {
        return createMirrorPauseMachine(this.connections, {
            ethToken: mirror.ethToken,
            tokenBridge: this.tokenBridgeAddress(),
            tempoBridge: this.config.tempo.bridge,
        });
    }

    /** Creates each configured guard that does not exist yet; the keeper key is its admin. */
    createGuards$(): Observable<void> {
        const { bridge, backstop } = this.config.tempo;
        return from(this.config.guards).pipe(
            concatMap((guard) =>
                currentOf$(this.guardMachine(guard)).pipe(
                    switchMap(({ guardId, guard: existing }) =>
                        existing
                            ? of(this.log(`${guard.name}: guard ${guardId} exists`))
                            : this.send$(
                                  'tempo',
                                  this.tempoSigner,
                                  this.bridgeReadable$().pipe(
                                      map((readable): TransactionCall => {
                                          if (!readable)
                                              throw new Error(
                                                  `No Nori bridge state at ${bridge}; deploy it before creating guards`
                                              );
                                          return {
                                              to: backstop,
                                              data: backstopInterface.encodeFunctionData('createGuard', [
                                                  guard.token,
                                                  guardConfigOf(this.config, guard),
                                              ]),
                                              value: 0n,
                                          };
                                      })
                                  ),
                                  backstopInterface
                              ).pipe(
                                  map((end) =>
                                      this.log(
                                          'failed' in end
                                              ? `${guard.name}: createGuard failed: ${end.failed}`
                                              : `${guard.name}: created guard ${guardId} (${end.outcome})`
                                      )
                                  )
                              )
                    )
                )
            ),
            ignoreElements()
        );
    }

    /**
     * One NoriSnapshot transaction covering every configured query, pending
     * as soon as it is sent. A reverted one (e.g. the queue fee changed) has
     * no reads and is dropped; a failed one is logged, and `run` sends the
     * next one on its interval.
     */
    snapshot$(): Observable<void> {
        const queries = new Map<string, { target: string; data: string }>();
        for (const guard of this.config.guards) {
            for (const query of [guard.backing, guard.pause]) {
                if (!query) continue;
                const { target, data, queryId } = queryOf(query);
                queries.set(queryId, { target, data });
            }
        }
        return defer(() => {
            const signer = this.ethereumSigner();
            let sentHash = '';
            const { noriSnapshot } = this.config.ethereum;
            return this.send$(
                'ethereum',
                signer,
                currentOf$(
                    createFeeMachine(this.connections, noriSnapshot, async (provider) =>
                        NoriSnapshot__factory.connect(noriSnapshot, provider).snapshotFee()
                    )
                ).pipe(
                    map(
                        ({ fee }): TransactionCall => ({
                            to: noriSnapshot,
                            data: noriSnapshotInterface.encodeFunctionData('snapshot', [[...queries.values()]]),
                            value: fee,
                        })
                    )
                ),
                noriSnapshotInterface,
                (hash) => {
                    sentHash = hash;
                    this.updateState((state) => ({ ...state, pending: [...state.pending, hash] }));
                }
            ).pipe(
                map((end) => {
                    if ('failed' in end) return this.log(`snapshot failed: ${end.failed}`);
                    if (end.outcome === 'mined')
                        return this.log(`snapshot ${sentHash}: ${queries.size} queries`);
                    this.updateState((state) => ({
                        ...state,
                        pending: state.pending.filter((hash) => hash !== sentHash),
                    }));
                    this.log(`snapshot ${sentHash || '(not sent)'} ${end.outcome}, dropped`);
                })
            );
        });
    }

    /** Records each guard's token supply (guards checkpointed too recently are skipped). */
    checkpoint$(): Observable<void> {
        const { backstop } = this.config.tempo;
        return from(this.config.guards).pipe(
            concatMap((guard) =>
                this.send$(
                    'tempo',
                    this.tempoSigner,
                    currentOf$(this.guardMachine(guard)).pipe(
                        map(
                            ({ guardId }): TransactionCall => ({
                                to: backstop,
                                data: backstopInterface.encodeFunctionData('checkpoint', [guardId]),
                                value: 0n,
                            })
                        )
                    ),
                    backstopInterface
                ).pipe(
                    map((end) => {
                        if ('failed' in end) this.log(`${guard.name}: checkpoint failed: ${end.failed}`);
                        else if (end.outcome === 'mined') this.log(`${guard.name}: checkpoint`);
                        else if (end.outcome !== CHECKPOINT_TOO_SOON) this.log(`${guard.name}: checkpoint ${end.outcome}`);
                    })
                )
            ),
            ignoreElements()
        );
    }

    /** Each guard's backing and pause reads a snapshot submits, with the guard's id from its machine. */
    private guardReads$(): Observable<GuardRead[]> {
        const { guards } = this.config;
        if (guards.length === 0) return of([]);
        return combineLatest(guards.map((guard) => currentOf$(this.guardMachine(guard)))).pipe(
            take(1),
            map((read) =>
                guards.flatMap((guard, i) =>
                    (
                        [
                            [ReadKind.Backing, 'backing', guard.backing],
                            [ReadKind.Pause, 'pause', guard.pause],
                        ] as const
                    ).flatMap(([kind, label, query]) =>
                        query
                            ? [
                                  {
                                      read: `${guard.name} ${label}`,
                                      guardId: read[i].guardId,
                                      kind,
                                      queryId: queryOf(query).queryId,
                                  },
                              ]
                            : []
                    )
                )
            )
        );
    }

    /**
     * Follows a pending snapshot until its reads are submitted, then drops it
     * from the pending ones.
     *
     * @param snapshotTxHash The snapshot transaction.
     * @param untilWaiting Ends once it is looked up and its batch is not proven yet, as a one-off `submit` does.
     * @returns Its states, until it ends.
     */
    private submission$(snapshotTxHash: string, untilWaiting: boolean): Observable<SnapshotSubmissionState> {
        return this.guardReads$().pipe(switchMap((reads) => this.submissionOf$(snapshotTxHash, reads, untilWaiting)));
    }

    /**
     * Follows a pending snapshot with the reads it submits, as `submission$`.
     *
     * @param snapshotTxHash The snapshot transaction.
     * @param reads The guard reads it submits.
     * @param untilWaiting Ends once it is looked up and its batch is not proven yet.
     * @returns Its states, until it ends.
     */
    private submissionOf$(
        snapshotTxHash: string,
        reads: GuardRead[],
        untilWaiting: boolean
    ): Observable<SnapshotSubmissionState> {
        const submission = createSnapshotSubmissionMachine(
            this.connections,
            {
                snapshotTxHash,
                noriSnapshot: this.config.ethereum.noriSnapshot,
                proofQueue: this.config.ethereum.proofQueue,
                tempoBridge: this.config.tempo.bridge,
                backstop: this.config.tempo.backstop,
                reads,
            },
            this.tempoSigner,
            this.config.intervals.pollSecs * 1000,
            this.bridgeChanged$()
        );
        const ended = (state: SnapshotSubmissionState) =>
            state.node === 'submitted' ||
            state.node === 'transactionReplaced' ||
            state.node === 'transactionDropped' ||
            (untilWaiting && state.node === 'waitingForProof');
        const drop = () =>
            this.updateState((current) => ({
                ...current,
                pending: current.pending.filter((hash) => hash !== snapshotTxHash),
            }));
        return submission.state$.pipe(
            tap((state) => {
                if (state.node === 'transactionReplaced' || state.node === 'transactionDropped') {
                    this.log(
                        `snapshot ${snapshotTxHash}: ${state.node === 'transactionReplaced' ? 'replaced' : 'dropped'}, no proof request, dropped`
                    );
                    drop();
                }
                if (state.node !== 'submitted') return;
                for (const { read, outcome } of state.data.outcomes) {
                    if (outcome !== 'mined' && outcome !== READ_NOT_NEWER) this.log(`${read}: read ${outcome}, dropped`);
                }
                this.log(`snapshot ${snapshotTxHash}: reads submitted`);
                drop();
            }),
            takeWhile((state) => !ended(state), true),
            finalize(() => submission.close())
        );
    }

    /** Submits every pending snapshot's reads whose batch is proven, and leaves the rest pending. */
    submit$(): Observable<void> {
        return defer(() => from(this.loadState().pending)).pipe(
            concatMap((hash) => this.submission$(hash, true)),
            ignoreElements(),
            finalize(() => {
                const waiting = this.loadState().pending.length;
                if (waiting) this.log(`${waiting} snapshot(s) pending: waiting for a proof`);
            })
        );
    }

    /**
     * Whether a mirror's pause state must be synced: the ERC-20's `paused()`
     * differs from what the bridge last synced. A token never synced counts
     * as synced unpaused, as a new mirror starts unpaused; a token without a
     * mirror on Tempo is skipped (`status` names it).
     *
     * @param data The mirror's pause state.
     * @returns `true` when it must be synced.
     */
    private needsSync({ pause }: Extract<MirrorPauseState, { node: 'current' }>['data']): boolean {
        if (!pause?.mirror) return false;
        const wanted = pause.erc20Paused ? PAUSE_STATE_PAUSED : PAUSE_STATE_UNPAUSED;
        return !(pause.synced === wanted || (pause.synced === 0n && !pause.erc20Paused));
    }

    /** Sends `NoriTokenBridge.syncPause` for one mirror, paying the queue fee; pending as soon as it is sent. */
    private syncPause$(mirror: MirrorEntry, paused: boolean): Observable<void> {
        return defer(() => {
            const signer = this.ethereumSigner();
            const tokenBridge = this.tokenBridgeAddress();
            // The queue the token bridge pins (`NoriTokenBridge.proofQueue`, immutable) is the configured one.
            const { proofQueue } = this.config.ethereum;
            return this.send$(
                'ethereum',
                signer,
                currentOf$(
                    createFeeMachine(this.connections, proofQueue, async (provider) =>
                        NoriProofRequestQueue__factory.connect(proofQueue, provider).proofRequestQueueFee()
                    )
                ).pipe(
                    map(
                        ({ fee }): TransactionCall => ({
                            to: tokenBridge,
                            data: noriTokenBridgeInterface.encodeFunctionData('syncPause', [mirror.ethToken]),
                            value: fee,
                        })
                    )
                ),
                noriTokenBridgeInterface,
                (syncPauseTxHash) =>
                    this.updateState((state) => ({
                        ...state,
                        pausesPending: [
                            ...state.pausesPending,
                            { name: mirror.name, ethToken: mirror.ethToken, syncPauseTxHash },
                        ],
                    }))
            );
        }).pipe(
            map((end) =>
                this.log(
                    'failed' in end
                        ? `${mirror.name}: pause sync failed: ${end.failed}`
                        : `${mirror.name}: syncPause ${end.outcome}, paused ${paused}`
                )
            )
        );
    }

    /** Syncs each mirrored ERC-20 whose pause state changed. */
    syncPauses$(): Observable<void> {
        return from(this.config.mirrors ?? []).pipe(
            concatMap((mirror) =>
                currentOf$(this.mirrorPauseMachine(mirror)).pipe(
                    switchMap((data) =>
                        this.needsSync(data) ? this.syncPause$(mirror, data.pause?.erc20Paused ?? false) : EMPTY
                    )
                )
            ),
            ignoreElements()
        );
    }

    /**
     * Follows a pending pause sync until its proven pause state is applied,
     * then drops it from the pending ones.
     *
     * @param pause The pending sync.
     * @param untilWaiting Ends once it is looked up and its batch is not proven yet, as a one-off `apply-pauses` does.
     * @returns Its states, until it ends.
     */
    private pauseApplication$(pause: PendingPause, untilWaiting: boolean): Observable<PauseApplicationState> {
        const application = createPauseApplicationMachine(
            this.connections,
            {
                syncPauseTxHash: pause.syncPauseTxHash,
                proofQueue: this.config.ethereum.proofQueue,
                tokenBridge: this.tokenBridgeAddress(),
                tempoBridge: this.config.tempo.bridge,
            },
            this.tempoSigner,
            this.config.intervals.pollSecs * 1000,
            this.bridgeChanged$()
        );
        const ended = (state: PauseApplicationState) =>
            state.node === 'applied' ||
            state.node === 'notAPauseRequest' ||
            state.node === 'transactionReplaced' ||
            state.node === 'transactionDropped' ||
            (untilWaiting && state.node === 'waitingForProof');
        const drop = () =>
            this.updateState((current) => ({
                ...current,
                pausesPending: current.pausesPending.filter(
                    ({ syncPauseTxHash }) => syncPauseTxHash !== pause.syncPauseTxHash
                ),
            }));
        return application.state$.pipe(
            tap((state) => {
                if (state.node === 'notAPauseRequest') {
                    this.log(`${pause.name}: ${pause.syncPauseTxHash} is not a pause request of the token bridge, dropped`);
                    drop();
                }
                if (state.node === 'transactionReplaced' || state.node === 'transactionDropped') {
                    this.log(
                        `${pause.name}: ${pause.syncPauseTxHash} ${state.node === 'transactionReplaced' ? 'replaced' : 'dropped'}, no proof request, dropped`
                    );
                    drop();
                }
                if (state.node !== 'applied') return;
                const { outcome, paused, proofQueueBatchIndex } = state.data;
                if (outcome === 'mined')
                    this.log(
                        `${pause.name}: mirror ${paused ? 'paused' : 'unpaused'} (proof queue batch ${proofQueueBatchIndex})`
                    );
                else if (outcome !== PAUSE_NOT_NEWER) this.log(`${pause.name}: applyPause ${outcome}, dropped`);
                drop();
            }),
            takeWhile((state) => !ended(state), true),
            finalize(() => application.close())
        );
    }

    /** Applies each pending pause sync whose batch is proven, and leaves the rest pending. */
    applyPauses$(): Observable<void> {
        return defer(() => from(this.loadState().pausesPending)).pipe(
            concatMap((pause) => this.pauseApplication$(pause, true)),
            ignoreElements(),
            finalize(() => {
                const waiting = this.loadState().pausesPending.length;
                if (waiting) this.log(`${waiting} pause sync(s) pending: waiting for a proof`);
            })
        );
    }

    /**
     * Clears each tripped guard's latch (the keeper key must be its admin).
     * Unlatch after a proven read shows the backing restored, or the next
     * read trips it again.
     */
    unlatch$(): Observable<void> {
        const { backstop } = this.config.tempo;
        return from(this.config.guards).pipe(
            concatMap((guard) =>
                currentOf$(this.guardMachine(guard)).pipe(
                    switchMap(({ guardId, guard: state }) => {
                        if (!state) return of(this.log(`${guard.name}: no guard ${guardId}`));
                        if (!state.tripped) return of(this.log(`${guard.name}: not tripped`));
                        return this.send$(
                            'tempo',
                            this.tempoSigner,
                            of({
                                to: backstop,
                                data: backstopInterface.encodeFunctionData('unlatch', [guardId]),
                                value: 0n,
                            }),
                            backstopInterface
                        ).pipe(
                            map((end) =>
                                this.log(
                                    'failed' in end
                                        ? `${guard.name}: unlatch failed: ${end.failed}`
                                        : `${guard.name}: unlatched (backing ${state.backing} at Ethereum block ${state.backingEthBlock})`
                                )
                            )
                        );
                    })
                )
            ),
            ignoreElements()
        );
    }

    /**
     * Nori's progress through the proof queue, then each guard's status, then
     * each mirror's, each time one changes. The machines read through are
     * closed when it is unsubscribed.
     */
    private statusLines$(): Observable<string[]> {
        return defer(() => {
            const bridgeState = createBridgeStateMachine(this.connections, this.config.tempo.bridge);
            const queueHead = createProofQueueHeadMachine(this.connections, this.config.ethereum.proofQueue);
            const guards = this.config.guards.map((guard) => ({ guard, machine: this.guardMachine(guard) }));
            const mirrors = (this.config.mirrors ?? []).map((mirror) => ({
                mirror,
                machine: this.mirrorPauseMachine(mirror),
            }));
            const guardLine = (
                { name }: GuardEntry,
                { guardId, guard }: Extract<GuardState, { node: 'current' }>['data']
            ) =>
                guard
                    ? `${name}: ${guardStatusName(guard.status)} | backing ${guard.backing} | supply ${guard.supply}` +
                      ` | Ethereum block ${guard.backingEthBlock} | paused ${guard.paused}` +
                      (guard.tripped ? ` | tripped at block ${guard.tripEthBlock}, deficit ${guard.tripDeficit}` : '')
                    : `${name}: no guard ${guardId}`;
            const mirrorLine = (mirror: MirrorEntry, { pause }: Extract<MirrorPauseState, { node: 'current' }>['data']) => {
                if (!pause?.mirror)
                    return `${mirror.name}: no mirror of ${mirror.ethToken} on Tempo; register it (register-mirror)`;
                const waiting = this.loadState().pausesPending.filter(
                    ({ ethToken }) => ethToken === mirror.ethToken
                ).length;
                return (
                    `${mirror.name}: ERC-20 paused ${pause.erc20Paused} | mirror ${pause.mirror} paused ${pause.mirrorPaused}` +
                    ` | ${waiting} pause sync(s) waiting`
                );
            };
            return combineLatest([
                currentData$(bridgeState),
                currentData$(queueHead),
                guards.length ? combineLatest(guards.map(({ machine }) => currentData$(machine))) : of([]),
                mirrors.length ? combineLatest(mirrors.map(({ machine }) => currentData$(machine))) : of([]),
            ]).pipe(
                map(([{ bridgeState: nori }, { head }, guardData, mirrorData]) => [
                    nori
                        ? `nori: beacon slot ${nori.latestHead} | ${nori.queueCursor} of ${head} queue requests proven` +
                          ` | ${nori.proofQueueBatchCount} batches | ${this.loadState().pending.length} snapshot(s) waiting`
                        : `nori: no bridge state at ${this.config.tempo.bridge}`,
                    ...guards.map(({ guard }, i) => guardLine(guard, guardData[i])),
                    ...mirrors.map(({ mirror }, i) => mirrorLine(mirror, mirrorData[i])),
                ]),
                finalize(() => {
                    bridgeState.close();
                    queueHead.close();
                    guards.forEach(({ machine }) => machine.close());
                    mirrors.forEach(({ machine }) => machine.close());
                })
            );
        });
    }

    /** Prints Nori's progress through the proof queue, then each guard's status, then each mirror's. */
    status$(): Observable<void> {
        return this.statusLines$().pipe(
            take(1),
            map((lines) => lines.forEach((line) => this.log(line)))
        );
    }

    /**
     * Checkpoints and snapshots on the configured intervals, follows every
     * pending snapshot and pause sync until it is applied, syncs each
     * mirror's pause state as it changes, and prints each status line when it
     * changes. Never completes.
     */
    run$(): Observable<never> {
        const { snapshotSecs, checkpointSecs, pollSecs } = this.config.intervals;
        const stateFile$ = timer(0, pollSecs * 1000).pipe(map(() => this.loadState()));
        return merge(
            timer(0, checkpointSecs * 1000).pipe(exhaustMap(() => this.checkpoint$())),
            timer(0, snapshotSecs * 1000).pipe(exhaustMap(() => this.snapshot$())),
            newItems$(
                stateFile$.pipe(map(({ pending }) => pending)),
                (hash) => hash
            ).pipe(mergeMap((hash) => this.submission$(hash, false))),
            newItems$(
                stateFile$.pipe(map(({ pausesPending }) => pausesPending)),
                ({ syncPauseTxHash }) => syncPauseTxHash
            ).pipe(mergeMap((pause) => this.pauseApplication$(pause, false))),
            ...(this.config.mirrors ?? []).map((mirror) =>
                defer(() => {
                    const machine = this.mirrorPauseMachine(mirror);
                    return currentData$(machine).pipe(
                        filter((data) => this.needsSync(data)),
                        // One sync at a time per mirror: the bridge's synced state moves once it is mined.
                        exhaustMap((data) => this.syncPause$(mirror, data.pause?.erc20Paused ?? false)),
                        finalize(() => machine.close())
                    );
                })
            ),
            this.statusLines$().pipe(
                startWith([] as string[]),
                pairwise(),
                tap(([shown, lines]) => lines.filter((line) => !shown.includes(line)).forEach((line) => this.log(line)))
            )
        ).pipe(ignoreElements()) as Observable<never>;
    }
}
