import { define, type StateUnion } from '@yaw-rx/ystate';
import { type RequestWitness } from '@nori-zk/nori-bridge-tempo-sdk';
import { type SnapshotEvent } from '../snapshotWitness.js';

/** How one guard read ended. */
export interface SubmittedReadOutcome {
    read: string;
    /** `mined`, `reverted` (mined with status 0), or the contract error that refused it (e.g. `ReadNotNewer`). */
    outcome: string;
}

/**
 * One snapshot transaction the keeper sent, until every guard's reads of it
 * are submitted to the Backstop. It gates on the proven request machine
 * (`createProvenRequestMachine`), the snapshot event machine
 * (`createSnapshotEventMachine`) and one signer transaction machine per
 * read (`createSignerTransactionMachine`).
 *
 * - `findingRequest`: the snapshot's proof request is being looked up.
 * - `waitingForProof`: it is looked up and no committed batch covers it yet.
 * - Once proven (`proven`, from either), `readingEvent` holds the batch and
 *   the witness while the snapshot's `Snapshot` event is read.
 * - `submitting` holds the event too while each guard's backing and pause
 *   reads are sent with the keeper's signer. A read whose send failed is
 *   sent again by the keeper.
 * - `submitted` holds how each read ended, once each is mined or refused
 *   by the Backstop. It is terminal: the snapshot is no longer pending.
 * - The snapshot transaction can end without enqueuing its proof request:
 *   `transactionReplaced` or `transactionDropped`, both terminal.
 * - `closed` is terminal.
 */
export const SnapshotSubmissionGraph = define({
    nodes: {
        findingRequest: {},
        waitingForProof: {},
        transactionReplaced: {},
        transactionDropped: {},
        readingEvent: { proofQueueBatchIndex: 0n, witness: {} as RequestWitness },
        submitting: { proofQueueBatchIndex: 0n, witness: {} as RequestWitness, event: {} as SnapshotEvent },
        submitted: { proofQueueBatchIndex: 0n, outcomes: [] as SubmittedReadOutcome[] },
        closed: {},
    },
    edges: {
        requestFound: { from: 'findingRequest', to: 'waitingForProof', on: 'requestFound.next' },
        provenAtLookUp: { from: 'findingRequest', to: 'readingEvent', on: 'proven.next' },
        proven: { from: 'waitingForProof', to: 'readingEvent', on: 'proven.next' },
        eventRead: { from: 'readingEvent', to: 'submitting', on: 'eventRead.next' },
        readsSubmitted: { from: 'submitting', to: 'submitted', on: 'readsSubmitted.next' },
        replacedAtLookUp: { from: 'findingRequest', to: 'transactionReplaced', on: 'transactionReplaced.next' },
        replaced: { from: 'waitingForProof', to: 'transactionReplaced', on: 'transactionReplaced.next' },
        droppedAtLookUp: { from: 'findingRequest', to: 'transactionDropped', on: 'transactionDropped.next' },
        dropped: { from: 'waitingForProof', to: 'transactionDropped', on: 'transactionDropped.next' },
        closedWhileFindingRequest: { from: 'findingRequest', to: 'closed', on: 'close.next' },
        closedWhileWaitingForProof: { from: 'waitingForProof', to: 'closed', on: 'close.next' },
        closedWhileReadingEvent: { from: 'readingEvent', to: 'closed', on: 'close.next' },
        closedWhileSubmitting: { from: 'submitting', to: 'closed', on: 'close.next' },
    },
});

/** The snapshot submission's state: a node of the graph and its data. */
export type SnapshotSubmissionState = StateUnion<typeof SnapshotSubmissionGraph.nodes>;
