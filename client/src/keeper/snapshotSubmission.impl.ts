import { type Signer } from 'ethers';
import {
    combineLatest,
    EMPTY,
    filter,
    map,
    type Observable,
    of,
    ReplaySubject,
    shareReplay,
    Subject,
    switchMap,
    take,
} from 'rxjs';
import {
    createSignerTransactionMachine,
    type ProofRequestConnections,
    type SignerTransactionState,
} from '@nori-zk/nori-bridge-tempo-sdk';
import { Backstop__factory, type ReadKind } from '@nori-zk/tempo-backstop';
import { closeWhenEnded } from '../owned.js';
import { type ProvenRequestState } from '../provenRequest.js';
import { createProvenRequestMachine } from '../provenRequest.impl.js';
import { type SnapshotEventState } from '../snapshotEvent.js';
import { createSnapshotEventMachine } from '../snapshotEvent.impl.js';
import { type SnapshotEvent, snapshotResultWitness } from '../snapshotWitness.js';
import { keepSending, sendOutcomeOf, sendOver } from './sends.js';
import { SnapshotSubmissionGraph, type SubmittedReadOutcome } from './snapshotSubmission.js';

/** The Backstop's ABI: what its calls are encoded with, and what names a refusal (e.g. `ReadNotNewer`). */
const backstopInterface = Backstop__factory.createInterface();

/** One guard read a snapshot submits: which guard, which kind, and the query whose result it is. */
export interface GuardRead {
    /** `<guard name> backing` or `<guard name> pause`. */
    read: string;
    /** The guard's id on the Backstop (`Backstop.guardIdOf` its token and the keeper's address). */
    guardId: string;
    kind: ReadKind;
    queryId: string;
}

/** The snapshot transaction, where it is proven, and the reads to submit. */
export interface SnapshotSubmissionRequest {
    snapshotTxHash: string;
    noriSnapshot: string;
    proofQueue: string;
    /** The `NoriTempoTokenBridge` that proves the queue. */
    tempoBridge: string;
    backstop: string;
    reads: GuardRead[];
}

/** The proven request machine once proven. */
type Proven = Extract<ProvenRequestState, { node: 'proven' }>;

/** The event machine once it holds the event. */
type EventRead = Extract<SnapshotEventState, { node: 'current' }> & { data: { event: SnapshotEvent } };

/** A running signer transaction machine. */
type Send = ReturnType<typeof createSignerTransactionMachine>;

/**
 * Whether the proven request machine has its proof and witness.
 *
 * @param state Its state.
 * @returns `true` at `proven`.
 */
const proven = (state: ProvenRequestState): state is Proven => state.node === 'proven';

/**
 * Whether the event machine holds the event.
 *
 * @param state Its state.
 * @returns `true` once it is current with the event.
 */
const eventRead = (state: SnapshotEventState): state is EventRead =>
    state.node === 'current' && state.data.event !== undefined;

/**
 * Starts following one snapshot transaction the keeper sent: until Nori has
 * proven its batch, then its event, then each guard read sent with the
 * keeper's signer until mined or refused. The proven request and event
 * machines start at once from the snapshot transaction; each read's
 * transaction starts from the proven batch and the event, its input, once
 * both are known, and is sent at once. The flow's own steps gate on their
 * states.
 *
 * @param connections The Ethereum and Tempo chains, from `createConnections`.
 * @param request The snapshot transaction, the addresses and the reads.
 * @param signer The keeper's Tempo signer.
 * @param resendAfterMs How long a read whose send failed waits before it is sent again.
 * @param recheckTrigger$ An extra signal to read the proof request again.
 * @returns The running machine; `submitted` carries how each read ended. Its control:
 *   - `close()`: moves the machine to `closed`.
 */
export function createSnapshotSubmissionMachine(
    connections: ProofRequestConnections,
    request: SnapshotSubmissionRequest,
    signer: Signer,
    resendAfterMs: number,
    recheckTrigger$: Observable<unknown> = EMPTY
) {
    const close$ = new Subject<void>();
    const provenRequest = createProvenRequestMachine(
        connections,
        {
            proofQueueAddress: request.proofQueue,
            proofRequestTxHash: request.snapshotTxHash,
            bridgeAddress: request.tempoBridge,
        },
        recheckTrigger$
    );
    const event = createSnapshotEventMachine(connections, request.noriSnapshot, request.snapshotTxHash);
    const proven$ = provenRequest.state$.pipe(filter(proven), take(1), shareReplay(1));
    const event$ = event.state$.pipe(filter(eventRead), take(1), shareReplay(1));

    /** The proven request machine reaching `node`, once. */
    const provenRequestAt$ = (node: ProvenRequestState['node']): Observable<void> =>
        provenRequest.state$.pipe(
            filter((state) => state.node === node),
            take(1),
            map((): void => undefined)
        );

    // One signer transaction per read, from the proven batch and the event.
    const sends = new ReplaySubject<Send[]>(1);
    const startSends = combineLatest([proven$, event$]).subscribe(([{ data }, { data: read }]) =>
            sends.next(
                request.reads.map((guardRead) =>
                    createSignerTransactionMachine(
                        connections,
                        'tempo',
                        signer,
                        {
                            to: request.backstop,
                            data: backstopInterface.encodeFunctionData('submitRead', [
                                guardRead.guardId,
                                guardRead.kind,
                                data.proofAvailable.proofQueueBatchIndex,
                                snapshotResultWitness(request.noriSnapshot, read.event, guardRead.queryId, data.witness),
                            ]),
                            value: 0n,
                        },
                        { errors: backstopInterface }
                    )
                )
            )
        );
    const sending = keepSending(sends, resendAfterMs);
    const sendStates$: Observable<SignerTransactionState[]> = sends.pipe(
        switchMap((machines) =>
            machines.length === 0 ? of([]) : combineLatest(machines.map((machine) => machine.state$))
        )
    );

    const machine = SnapshotSubmissionGraph.implement({
        requestFound: {
            $: () => provenRequestAt$('waitingForProof'),
            next: () => ({}),
        },
        transactionReplaced: {
            $: () => provenRequestAt$('transactionReplaced'),
            next: () => ({}),
        },
        transactionDropped: {
            $: () => provenRequestAt$('transactionDropped'),
            next: () => ({}),
        },
        proven: {
            $: () => proven$.pipe(map(({ data }) => data)),
            next: (data) => ({
                proofQueueBatchIndex: data.proofAvailable.proofQueueBatchIndex,
                witness: data.witness,
            }),
        },
        eventRead: {
            $: () => event$.pipe(map(({ data }) => data.event)),
            next: (read, _dest, source) => ({
                proofQueueBatchIndex: source.proofQueueBatchIndex,
                witness: source.witness,
                event: read,
            }),
        },
        readsSubmitted: {
            $: () =>
                sendStates$.pipe(
                    filter((states) => states.every(sendOver)),
                    take(1),
                    map((states) =>
                        states.map(
                            (state, i): SubmittedReadOutcome => ({
                                read: request.reads[i].read,
                                outcome: sendOver(state) ? sendOutcomeOf(state) : '',
                            })
                        )
                    )
                ),
            next: (outcomes, _dest, source) => ({ proofQueueBatchIndex: source.proofQueueBatchIndex, outcomes }),
        },
        close: {
            $: () => close$,
            next: () => ({}),
        },
    });

    const running = machine.close().start('findingRequest');
    closeWhenEnded(running, () => {
        startSends.unsubscribe();
        sending.unsubscribe();
        provenRequest.close();
        event.close();
        sends.pipe(take(1)).subscribe((machines) => machines.forEach((send) => send.close()));
    });

    return Object.assign(running, { close: () => close$.next() });
}
