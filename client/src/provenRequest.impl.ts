import { EMPTY, filter, map, type Observable, ReplaySubject, shareReplay, Subject, switchMap, take } from 'rxjs';
import {
    createProofRequestStateMachine,
    createProofRequestWitnessMachine,
    type FollowedProofRequest,
    type ProofRequestConnections,
    type ProofRequestStateNodeUnion,
    type ProofRequestWitnessState,
    type RequestWitness,
    type VerifiedRequestWitness,
} from '@nori-zk/nori-bridge-tempo-sdk';
import { closeWhenEnded } from './owned.js';
import { ProvenRequestGraph } from './provenRequest.js';

/** The proof request machine once a committed batch covers the request. */
type ProofAvailable = Extract<ProofRequestStateNodeUnion, { node: 'proofAvailable' }>;

/** The witness machine once it holds the witness. */
type WitnessRead = Extract<ProofRequestWitnessState, { node: 'current' }> & {
    data: { witness: RequestWitness; verifiedWitness: VerifiedRequestWitness };
};

/** A running witness machine. */
type WitnessMachine = ReturnType<typeof createProofRequestWitnessMachine>;

/**
 * Whether the proof request machine has found a committed batch covering the request.
 *
 * @param state The proof request machine's state.
 * @returns `true` at `proofAvailable`.
 */
const proofAvailable = (state: ProofRequestStateNodeUnion): state is ProofAvailable => state.node === 'proofAvailable';

/**
 * Whether the witness machine holds the witness.
 *
 * @param state The witness machine's state.
 * @returns `true` once it is current with the witness.
 */
const witnessRead = (state: ProofRequestWitnessState): state is WitnessRead =>
    state.node === 'current' && state.data.witness !== undefined && state.data.verifiedWitness !== undefined;

/**
 * Starts following one proof request until Nori has proven its batch, then
 * reads the request's witness in it. The proof request machine starts at
 * once; the witness machine starts from the batch covering the request, its
 * input, once that is known. The flow's own steps gate on their states.
 *
 * @param connections The Ethereum and Tempo chains, from `createConnections`.
 * @param request The transaction that enqueued the request, and the addresses.
 * @param recheckTrigger$ An extra signal to read the request again, e.g. the bridge's batches changing.
 * @returns The running machine; `proven` carries the batch and the witness. Its control:
 *   - `close()`: moves the machine to `closed`.
 */
export function createProvenRequestMachine(
    connections: ProofRequestConnections,
    request: FollowedProofRequest,
    recheckTrigger$: Observable<unknown> = EMPTY
) {
    const close$ = new Subject<void>();
    const proofRequest = createProofRequestStateMachine(connections, request, undefined, undefined, recheckTrigger$);
    const proofAvailable$ = proofRequest.state$.pipe(
        filter(proofAvailable),
        take(1),
        map(({ data }) => data.snapshot),
        shareReplay(1)
    );
    /** The proof request machine reaching `node`, once. */
    const atNode$ = (node: ProofRequestStateNodeUnion['node']): Observable<void> =>
        proofRequest.state$.pipe(
            filter((state) => state.node === node),
            take(1),
            map((): void => undefined)
        );
    const witness = new ReplaySubject<WitnessMachine>(1);
    const startWitness = proofAvailable$.subscribe((snapshot) =>
        witness.next(createProofRequestWitnessMachine(connections, request.proofQueueAddress, snapshot))
    );

    const machine = ProvenRequestGraph.implement({
        requestFound: {
            $: () => atNode$('current'),
            next: () => ({}),
        },
        transactionReplaced: {
            $: () => atNode$('transactionReplaced'),
            next: () => ({}),
        },
        transactionDropped: {
            $: () => atNode$('transactionDropped'),
            next: () => ({}),
        },
        proofAvailable: {
            $: () => proofAvailable$,
            next: (snapshot) => ({ proofAvailable: snapshot }),
        },
        witnessRead: {
            $: () =>
                witness.pipe(
                    switchMap((reading) => reading.state$),
                    filter(witnessRead),
                    take(1)
                ),
            next: ({ data }, _dest, source) => ({
                proofAvailable: source.proofAvailable,
                witness: data.witness,
                verifiedWitness: data.verifiedWitness,
            }),
        },
        close: {
            $: () => close$,
            next: () => ({}),
        },
    });

    const running = machine.close().start('findingRequest');
    closeWhenEnded(running, () => {
        startWitness.unsubscribe();
        proofRequest.close();
        witness.pipe(take(1)).subscribe((reading) => reading.close());
    });

    return Object.assign(running, { close: () => close$.next() });
}
