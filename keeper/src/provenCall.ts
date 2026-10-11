import { define, type StateUnion } from '@yaw-rx/ystate';

/**
 * One proof request sent on Ethereum, until its proven leaf is taken by one
 * call on the Nori bridge on Tempo: a pause state applied to an ERC-20's
 * mirror (`applyPause`), or a lock claimed as the mirror (`mintERC20`). It
 * gates on the proven request machine (`createProvenRequestMachine`) and the
 * call's signer transaction machine (`createSignerTransactionMachine`).
 *
 * - `findingRequest`: the request is being looked up from the transaction
 *   that enqueued it.
 * - `waitingForProof`: it is looked up and no committed batch covers it yet.
 * - A proven request the call does not take (the wrong transaction) ends in
 *   `otherRequest`.
 * - `calling` holds the batch and the proven leaf's value while the call is
 *   sent with the signer. A send that failed is sent again by its owner.
 * - `called` holds how it ended: `mined`, `reverted`, or the bridge's error
 *   that refused it (`PauseNotNewer` when a newer pause was applied first,
 *   `ZeroMintAmount` when a later claim already minted the lock). It is
 *   terminal: the request is no longer pending.
 * - The transaction can end without enqueuing its proof request:
 *   `transactionReplaced` or `transactionDropped`, both terminal.
 * - `closed` is terminal.
 */
export const ProvenCallGraph = define({
    nodes: {
        findingRequest: {},
        waitingForProof: {},
        transactionReplaced: {},
        transactionDropped: {},
        calling: { proofQueueBatchIndex: 0n, value: 0n },
        called: { proofQueueBatchIndex: 0n, value: 0n, outcome: '' },
        otherRequest: {},
        closed: {},
    },
    edges: {
        requestFound: { from: 'findingRequest', to: 'waitingForProof', on: 'requestFound.next' },
        provenTakenAtLookUp: { from: 'findingRequest', to: 'calling', on: 'provenTaken.next' },
        provenTaken: { from: 'waitingForProof', to: 'calling', on: 'provenTaken.next' },
        provenOtherAtLookUp: { from: 'findingRequest', to: 'otherRequest', on: 'provenOther.next' },
        provenOther: { from: 'waitingForProof', to: 'otherRequest', on: 'provenOther.next' },
        sendOver: { from: 'calling', to: 'called', on: 'sendOver.next' },
        replacedAtLookUp: { from: 'findingRequest', to: 'transactionReplaced', on: 'transactionReplaced.next' },
        replaced: { from: 'waitingForProof', to: 'transactionReplaced', on: 'transactionReplaced.next' },
        droppedAtLookUp: { from: 'findingRequest', to: 'transactionDropped', on: 'transactionDropped.next' },
        dropped: { from: 'waitingForProof', to: 'transactionDropped', on: 'transactionDropped.next' },
        closedWhileFindingRequest: { from: 'findingRequest', to: 'closed', on: 'close.next' },
        closedWhileWaitingForProof: { from: 'waitingForProof', to: 'closed', on: 'close.next' },
        closedWhileCalling: { from: 'calling', to: 'closed', on: 'close.next' },
    },
});

/** The proven call's state: a node of the graph and its data. */
export type ProvenCallState = StateUnion<typeof ProvenCallGraph.nodes>;
