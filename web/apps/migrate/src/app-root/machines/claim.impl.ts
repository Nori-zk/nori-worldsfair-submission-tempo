import {
    BehaviorSubject,
    distinctUntilChanged,
    filter,
    map,
    NEVER,
    type Observable,
    Subject,
    switchMap,
    take,
} from 'rxjs';
import { Interface } from 'ethers';
import { type MachineStatus } from '@yaw-rx/ystate';
import {
    createProofRequestWitnessMachine,
    createWalletTransactionMachine,
    mintERC20Call,
    type ProofAvailableProofRequestSnapshot,
    type ProofRequestConnections,
    type ProofRequestStateNodeUnion,
    type ProofRequestWitnessState,
    tokenBridgeInterface,
    type VerifiedRequestWitness,
    type WalletTransactionState,
} from '@nori-zk/nori-bridge-tempo-sdk';
import { ClaimGraph, type ClaimState, type LockToClaim } from './claim.js';
import { sendOnChain } from './wallet-send.js';

/** The data of the claim's nodes. */
type DataAt<TNode extends ClaimState['node']> = Extract<ClaimState, { node: TNode }>['data'];

/** A running wallet transaction machine. */
type WalletTransaction = ReturnType<typeof createWalletTransactionMachine>;

/** A running witness machine. */
type WitnessMachine = ReturnType<typeof createProofRequestWitnessMachine>;

/** The bridge's error for a claim with nothing left to mint: a later claim minted this lock too. */
export const ZERO_MINT_AMOUNT = 'ZeroMintAmount';

/**
 * What names a refused claim: the bridge's errors, and a paused TIP-20's
 * (`ContractPaused`, which the bridge's mint passes on).
 */
const claimErrors = new Interface([...tokenBridgeInterface.fragments, 'error ContractPaused()']);

/** Where a claim reads and sends: the proof queue on Ethereum and the Nori bridge on Tempo. */
export interface ClaimAddresses {
    proofQueue: string;
    tempoBridge: string;
}

/** The witness machine once it holds the witness. */
type WitnessRead = Extract<ProofRequestWitnessState, { node: 'current' }> & {
    data: { verifiedWitness: VerifiedRequestWitness };
};

/**
 * Whether the witness machine holds the witness.
 *
 * @param state The witness machine's state.
 * @returns `true` once it is current with the witness.
 */
const witnessRead = (state: ProofRequestWitnessState): state is WitnessRead =>
    state.node === 'current' && state.data.verifiedWitness !== undefined;

/**
 * Why a claim's transaction did not go through, or `undefined` while it
 * still may. A wallet not on Tempo yet is not a failure: the transaction
 * is sent again once it is.
 *
 * @param state The claim's wallet transaction machine's state.
 * @returns The reason: the error that refused it, or how it was lost.
 */
const claimFailureOf = (state: WalletTransactionState): string | undefined => {
    if (state.node === 'refused')
        return state.data.errorName === ZERO_MINT_AMOUNT ? undefined : state.data.errorName;
    if (
        state.node === 'sendFailed' ||
        state.node === 'reverted' ||
        state.node === 'replaced' ||
        state.node === 'dropped'
    )
        return state.node;
    return undefined;
};

/**
 * Starts claiming one lock on Tempo, at `waitingForProof`.
 *
 * Its steps gate on other machines' states, as the ystate README's heater
 * gates on `temperature$`: the lock's proof request machine (shared with the
 * progress bar), the witness machine, started from the batch that proves
 * the lock, and the claim's wallet transaction on Tempo, made on entering
 * `claiming`. The transaction is sent each time it is ready: at once, and
 * again once the wallet, asked to switch to Tempo, is there.
 *
 * @param connections The Ethereum and Tempo chains; the claim goes through the Tempo wallet.
 * @param request$ The lock's proof request machine's states.
 * @param lock The lock: its transaction and recipient.
 * @param addresses The proof queue and the Nori bridge.
 * @returns The running claim. Its controls:
 *   - `claim()`: claims once the witness is read, or again after a decline or a failure.
 *   - `close()`: closes the claim, its witness machine and its transaction.
 */
export function createClaimMachine(
    connections: ProofRequestConnections,
    request$: Observable<ProofRequestStateNodeUnion>,
    lock: LockToClaim,
    addresses: ClaimAddresses,
): ClaimMachine {
    const claim$ = new Subject<void>();
    const witness$ = new BehaviorSubject<WitnessMachine | undefined>(undefined);
    const transaction$ = new BehaviorSubject<WalletTransaction | undefined>(undefined);
    const transactionState$: Observable<WalletTransactionState> = transaction$.pipe(
        switchMap((transaction) => (transaction === undefined ? NEVER : transaction.state$)),
    );

    /** The proof request machine reaching `node`, once. */
    const requestAt$ = (
        node: ProofRequestStateNodeUnion['node'],
    ): Observable<ProofRequestStateNodeUnion> =>
        request$.pipe(
            filter((state) => state.node === node),
            take(1),
        );

    const claim = ClaimGraph.implement({
        proofAvailable: {
            $: () =>
                requestAt$('proofAvailable').pipe(
                    map((state) => ('snapshot' in state.data ? state.data.snapshot : undefined)),
                    filter(
                        (snapshot): snapshot is ProofAvailableProofRequestSnapshot =>
                            snapshot !== undefined,
                    ),
                ),
            next: (proofAvailable, _dest, { lock: claimed }): DataAt<'readingWitness'> => ({
                lock: claimed,
                proofAvailable,
            }),
        },
        lockReplaced: {
            $: () => requestAt$('transactionReplaced'),
            next: (_replaced, _dest, source) => source,
        },
        lockDropped: {
            $: () => requestAt$('transactionDropped'),
            next: (_dropped, _dest, source) => source,
        },
        witnessRead: {
            $: () =>
                witness$.pipe(
                    switchMap((witness) => (witness === undefined ? NEVER : witness.state$)),
                    filter(witnessRead),
                    take(1),
                ),
            next: ({ data }, _dest, source): DataAt<'claimable'> => ({
                ...source,
                verifiedWitness: data.verifiedWitness,
            }),
        },
        claim: {
            $: () => claim$,
            next: (
                _claim,
                _dest,
                { lock: claimed, proofAvailable, verifiedWitness },
            ): DataAt<'claiming'> => ({
                lock: claimed,
                proofAvailable,
                verifiedWitness,
            }),
        },
        userDeclined: {
            $: () =>
                transactionState$.pipe(
                    filter(({ node }) => node === 'declined'),
                    take(1),
                ),
            next: (_declined, _dest, source): DataAt<'claimDeclined'> => source,
        },
        claimRefused: {
            $: () =>
                transactionState$.pipe(
                    map(claimFailureOf),
                    filter((error): error is string => error !== undefined),
                    take(1),
                ),
            next: (error, _dest, source): DataAt<'claimFailed'> => ({ ...source, error }),
        },
        nothingLeftToMint: {
            $: () =>
                transactionState$.pipe(
                    filter(
                        (state) =>
                            state.node === 'refused' && state.data.errorName === ZERO_MINT_AMOUNT,
                    ),
                    take(1),
                ),
            next: (_refused, _dest, { lock: claimed }): DataAt<'alreadyClaimed'> => ({
                lock: claimed,
            }),
        },
        claimConfirmed: {
            $: () =>
                transactionState$.pipe(
                    filter((state) => state.node === 'confirmed'),
                    map((state) =>
                        'transactionHash' in state.data ? state.data.transactionHash : '',
                    ),
                    take(1),
                ),
            next: (claimTxHash, _dest, { lock: claimed }): DataAt<'claimed'> => ({
                lock: claimed,
                claimTxHash,
            }),
        },
    });
    const running = claim
        .close()
        .start('waitingForProof', undefined, { waitingForProof: { lock } });

    // The witness is read on entering `readingWitness`, from the batch that
    // proves the lock; the claim's transaction is made on entering
    // `claiming` and closed on leaving it. Pulsed from outside the flow off
    // its state.
    const startWitness = running.state$
        .pipe(
            filter((state) => state.node === 'readingWitness'),
            take(1),
        )
        .subscribe((state) => {
            if (state.node !== 'readingWitness') return;
            witness$.next(
                createProofRequestWitnessMachine(
                    connections,
                    addresses.proofQueue,
                    state.data.proofAvailable,
                ),
            );
        });
    const startTransaction = running.state$
        .pipe(
            distinctUntilChanged(
                (before, now) => (before.node === 'claiming') === (now.node === 'claiming'),
            ),
        )
        .subscribe((state) => {
            transaction$.value?.close();
            if (state.node !== 'claiming') {
                transaction$.next(undefined);
                return;
            }
            transaction$.next(
                createWalletTransactionMachine(
                    connections,
                    'tempo',
                    mintERC20Call(
                        addresses.tempoBridge,
                        state.data.verifiedWitness,
                        state.data.proofAvailable.proofQueueBatchIndex,
                    ),
                    { errors: claimErrors },
                ),
            );
        });
    // Sent each time it is ready: at once, and again once the wallet, asked to switch, is on Tempo.
    const sending = sendOnChain(connections, 'tempo', transaction$);

    const stopClaim = running.stop.bind(running);
    return Object.assign(running, {
        claim: () => claim$.next(),
        close: () => {
            startWitness.unsubscribe();
            startTransaction.unsubscribe();
            sending.unsubscribe();
            witness$.value?.close();
            transaction$.value?.close();
            transaction$.next(undefined);
            stopClaim();
        },
    });
}

/** The running claim, with its controls. */
export interface ClaimMachine {
    state$: Observable<ClaimState>;
    status$: Observable<MachineStatus>;
    /** Claims once the witness is read, or again after a decline or a failure. */
    claim: () => void;
    /** Closes the claim, its witness machine and its transaction. */
    close: () => void;
}
