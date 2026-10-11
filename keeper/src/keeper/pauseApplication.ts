import { define, type StateUnion } from '@yaw-rx/ystate';

/**
 * One `syncPause` transaction the keeper sent, until its proven pause state
 * is applied to the ERC-20's mirror on Tempo. It gates on the proven
 * request machine (`createProvenRequestMachine`) and the `applyPause`
 * signer transaction machine (`createSignerTransactionMachine`).
 *
 * - `findingRequest`: the sync's proof request is being looked up.
 * - `waitingForProof`: it is looked up and no committed batch covers it yet.
 * - A proven request that is not a pause state of the token bridge (the
 *   wrong transaction) ends in `notAPauseRequest`.
 * - `applying` holds the batch and the pause state while `applyPause` is
 *   sent with the keeper's signer. A send that failed is sent again by the
 *   keeper.
 * - `applied` holds how it ended: `mined`, `reverted`, or the bridge's
 *   error that refused it (`PauseNotNewer` when a newer batch was applied
 *   first). It is terminal: the sync is no longer pending.
 * - The `syncPause` transaction can end without enqueuing its proof
 *   request: `transactionReplaced` or `transactionDropped`, both terminal.
 * - `closed` is terminal.
 */
export const PauseApplicationGraph = define({
    nodes: {
        findingRequest: {},
        waitingForProof: {},
        transactionReplaced: {},
        transactionDropped: {},
        applying: { proofQueueBatchIndex: 0n, paused: false },
        applied: { proofQueueBatchIndex: 0n, paused: false, outcome: '' },
        notAPauseRequest: {},
        closed: {},
    },
    edges: {
        requestFound: { from: 'findingRequest', to: 'waitingForProof', on: 'requestFound.next' },
        provenPauseAtLookUp: { from: 'findingRequest', to: 'applying', on: 'provenPause.next' },
        provenPause: { from: 'waitingForProof', to: 'applying', on: 'provenPause.next' },
        provenOtherAtLookUp: { from: 'findingRequest', to: 'notAPauseRequest', on: 'provenOther.next' },
        provenOther: { from: 'waitingForProof', to: 'notAPauseRequest', on: 'provenOther.next' },
        sendOver: { from: 'applying', to: 'applied', on: 'sendOver.next' },
        replacedAtLookUp: { from: 'findingRequest', to: 'transactionReplaced', on: 'transactionReplaced.next' },
        replaced: { from: 'waitingForProof', to: 'transactionReplaced', on: 'transactionReplaced.next' },
        droppedAtLookUp: { from: 'findingRequest', to: 'transactionDropped', on: 'transactionDropped.next' },
        dropped: { from: 'waitingForProof', to: 'transactionDropped', on: 'transactionDropped.next' },
        closedWhileFindingRequest: { from: 'findingRequest', to: 'closed', on: 'close.next' },
        closedWhileWaitingForProof: { from: 'waitingForProof', to: 'closed', on: 'close.next' },
        closedWhileApplying: { from: 'applying', to: 'closed', on: 'close.next' },
    },
});

/** The pause application's state: a node of the graph and its data. */
export type PauseApplicationState = StateUnion<typeof PauseApplicationGraph.nodes>;
