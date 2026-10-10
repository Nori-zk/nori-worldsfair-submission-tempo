import { type Signer } from 'ethers';
import { EMPTY, filter, map, type Observable, ReplaySubject, shareReplay, Subject, switchMap, take } from 'rxjs';
import { PAUSE_STATE_PAUSED } from '@nori-zk/ethereum-tempo-bridge';
import {
    applyPauseCall,
    createSignerTransactionMachine,
    type ProofRequestConnections,
    tokenBridgeInterface,
    type VerifiedRequestWitness,
} from '@nori-zk/nori-bridge-tempo-sdk';
import { PAUSE_KEY } from '@nori-zk/tempo-token-bridge';
import { closeWhenEnded } from '../owned.js';
import { type ProvenRequestState } from '../provenRequest.js';
import { createProvenRequestMachine } from '../provenRequest.impl.js';
import { PauseApplicationGraph } from './pauseApplication.js';
import { keepSending, sendOutcomeOf, sendOver } from './sends.js';

/** The `syncPause` transaction and the bridges on both chains. */
export interface PauseApplicationRequest {
    syncPauseTxHash: string;
    proofQueue: string;
    /** The `NoriTokenBridge` on Ethereum, whose pause states the proof covers. */
    tokenBridge: string;
    /** The `NoriTempoTokenBridge` that proves the queue and applies the pause. */
    tempoBridge: string;
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
 * Starts following one `syncPause` transaction the keeper sent: until Nori
 * has proven its batch, then `applyPause` sent with the keeper's signer
 * until mined or refused. The proven request machine starts at once from
 * the sync transaction; the `applyPause` transaction starts from the proven
 * pause state, its input, once that is known, and is sent at once. The
 * flow's own steps gate on their states.
 *
 * @param connections The Ethereum and Tempo chains, from `createConnections`.
 * @param request The `syncPause` transaction and the bridges.
 * @param signer The keeper's Tempo signer.
 * @param resendAfterMs How long a send that failed waits before it is sent again.
 * @param recheckTrigger$ An extra signal to read the proof request again.
 * @returns The running machine; `applied` carries how it ended. Its control:
 *   - `close()`: moves the machine to `closed`.
 */
export function createPauseApplicationMachine(
    connections: ProofRequestConnections,
    request: PauseApplicationRequest,
    signer: Signer,
    resendAfterMs: number,
    recheckTrigger$: Observable<unknown> = EMPTY
) {
    const close$ = new Subject<void>();

    /**
     * Whether a proven request is a pause state of the token bridge.
     *
     * @param witness The request's witness.
     * @returns `true` for the token bridge's `[PAUSE_KEY, token]` leaf.
     */
    const isPause = ({ value }: VerifiedRequestWitness) =>
        value.target.toLowerCase() === request.tokenBridge.toLowerCase() &&
        value.collectionKeys[0].toLowerCase() === PAUSE_KEY.toLowerCase();

    const provenRequest = createProvenRequestMachine(
        connections,
        {
            proofQueueAddress: request.proofQueue,
            proofRequestTxHash: request.syncPauseTxHash,
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
    const provenPause$ = proven$.pipe(filter((data) => isPause(data.verifiedWitness)));

    /** The proven request machine reaching `node`, once. */
    const provenRequestAt$ = (node: ProvenRequestState['node']): Observable<void> =>
        provenRequest.state$.pipe(
            filter((state) => state.node === node),
            take(1),
            map((): void => undefined)
        );

    // The `applyPause` transaction, from the proven pause state.
    const send = new ReplaySubject<Send>(1);
    const startSend = provenPause$.subscribe((data) =>
        send.next(
            createSignerTransactionMachine(
                connections,
                'tempo',
                signer,
                applyPauseCall(request.tempoBridge, data.verifiedWitness, data.proofAvailable.proofQueueBatchIndex),
                { errors: tokenBridgeInterface }
            )
        )
    );
    const sending = keepSending(
        send.pipe(map((machine) => [machine])),
        resendAfterMs
    );

    const machine = PauseApplicationGraph.implement({
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
        provenPause: {
            $: () => provenPause$,
            next: (data) => ({
                proofQueueBatchIndex: data.proofAvailable.proofQueueBatchIndex,
                paused: BigInt(data.verifiedWitness.value.value) === PAUSE_STATE_PAUSED,
            }),
        },
        provenOther: {
            $: () => proven$.pipe(filter((data) => !isPause(data.verifiedWitness))),
            next: () => ({}),
        },
        sendOver: {
            $: () =>
                send.pipe(
                    switchMap((applying) => applying.state$),
                    filter(sendOver),
                    take(1),
                    map(sendOutcomeOf)
                ),
            next: (outcome, _dest, source) => ({
                proofQueueBatchIndex: source.proofQueueBatchIndex,
                paused: source.paused,
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
        send.pipe(take(1)).subscribe((applying) => applying.close());
    });

    return Object.assign(running, { close: () => close$.next() });
}
