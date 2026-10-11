import { type Signer } from 'ethers';
import { EMPTY, filter, map, type Observable, ReplaySubject, shareReplay, Subject, switchMap, take } from 'rxjs';
import {
    createSignerTransactionMachine,
    type ProofRequestConnections,
    tokenBridgeInterface,
    type TransactionCall,
    type VerifiedRequestWitness,
} from '@nori-zk/nori-bridge-tempo-sdk';
import { keepSending, sendOutcomeOf, sendOver } from './keeper/sends.js';
import { closeWhenEnded } from './owned.js';
import { ProvenCallGraph } from './provenCall.js';
import { type ProvenRequestState } from './provenRequest.js';
import { createProvenRequestMachine } from './provenRequest.impl.js';

/** The transaction that enqueued the proof request, the bridges, and the call that takes its proven leaf. */
export interface ProvenCallRequest {
    proofRequestTxHash: string;
    proofQueue: string;
    /** The `NoriTempoTokenBridge` that proves the queue and takes the call. */
    tempoBridge: string;
    /** Whether the proven request is one the call takes (the leaf it expects). */
    takes: (witness: VerifiedRequestWitness) => boolean;
    /** The call, from the request's witness and the batch holding it (`applyPauseCall`, `mintERC20Call`). */
    callOf: (witness: VerifiedRequestWitness, proofQueueBatchIndex: bigint) => TransactionCall;
}

/** The proven request machine once proven. */
type Proven = Extract<ProvenRequestState, { node: 'proven' }>;

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
 * Starts following one proof request: until Nori has proven its batch, then
 * the call that takes its proven leaf sent with `signer` until mined or
 * refused. The proven request machine starts at once from the transaction;
 * the call's transaction starts from the proven leaf, its input, once that
 * is known, and is sent at once. The flow's own steps gate on their states.
 *
 * @param connections The Ethereum and Tempo chains, from `createConnections`.
 * @param request The transaction, the bridges and the call.
 * @param signer The Tempo signer that sends the call.
 * @param resendAfterMs How long a send that failed waits before it is sent again.
 * @param recheckTrigger$ An extra signal to read the proof request again.
 * @returns The running machine; `called` carries how it ended. Its control:
 *   - `close()`: moves the machine to `closed`.
 */
export function createProvenCallMachine(
    connections: ProofRequestConnections,
    request: ProvenCallRequest,
    signer: Signer,
    resendAfterMs: number,
    recheckTrigger$: Observable<unknown> = EMPTY
) {
    const close$ = new Subject<void>();

    const provenRequest = createProvenRequestMachine(
        connections,
        {
            proofQueueAddress: request.proofQueue,
            proofRequestTxHash: request.proofRequestTxHash,
            bridgeAddress: request.tempoBridge,
        },
        recheckTrigger$
    );
    const proven$ = provenRequest.state$.pipe(
        filter(proven),
        take(1),
        map(({ data }) => data),
        shareReplay(1)
    );
    const provenTaken$ = proven$.pipe(filter((data) => request.takes(data.verifiedWitness)));

    /** The proven request machine reaching `node`, once. */
    const provenRequestAt$ = (node: ProvenRequestState['node']): Observable<void> =>
        provenRequest.state$.pipe(
            filter((state) => state.node === node),
            take(1),
            map((): void => undefined)
        );

    // The call's transaction, from the proven leaf.
    const send = new ReplaySubject<Send>(1);
    const startSend = provenTaken$.subscribe((data) =>
        send.next(
            createSignerTransactionMachine(
                connections,
                'tempo',
                signer,
                request.callOf(data.verifiedWitness, data.proofAvailable.proofQueueBatchIndex),
                { errors: tokenBridgeInterface }
            )
        )
    );
    const sending = keepSending(
        send.pipe(map((machine) => [machine])),
        resendAfterMs
    );

    const machine = ProvenCallGraph.implement({
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
        provenTaken: {
            $: () => provenTaken$,
            next: (data) => ({
                proofQueueBatchIndex: data.proofAvailable.proofQueueBatchIndex,
                value: BigInt(data.verifiedWitness.value.value),
            }),
        },
        provenOther: {
            $: () => proven$.pipe(filter((data) => !request.takes(data.verifiedWitness))),
            next: () => ({}),
        },
        sendOver: {
            $: () =>
                send.pipe(
                    switchMap((calling) => calling.state$),
                    filter(sendOver),
                    take(1),
                    map(sendOutcomeOf)
                ),
            next: (outcome, _dest, source) => ({
                proofQueueBatchIndex: source.proofQueueBatchIndex,
                value: source.value,
                outcome,
            }),
        },
        close: {
            $: () => close$,
            next: () => ({}),
        },
    });

    const running = machine.close().start('findingRequest');
    closeWhenEnded(running, () => {
        startSend.unsubscribe();
        sending.unsubscribe();
        provenRequest.close();
        send.pipe(take(1)).subscribe((calling) => calling.close());
    });

    return Object.assign(running, { close: () => close$.next() });
}
