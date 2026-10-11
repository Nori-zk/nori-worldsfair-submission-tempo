import { define, type StateUnion } from '@yaw-rx/ystate';
import { readThroughConnectionsOf } from '@nori-zk/nori-bridge-tempo-sdk';

/**
 * A fee an Ethereum contract charges (`NoriSnapshot.snapshotFee`,
 * `NoriProofRequestQueue.proofRequestQueueFee`), read through the Ethereum
 * connection (`readThroughConnectionsOf`): read at once, then again on each
 * log of the contract, where a fee change shows. `current` holds the fee
 * last read.
 */
export const FeeGraph = define(readThroughConnectionsOf({ fee: 0n }));

/** The fee's state: a node of the graph and its data. */
export type FeeState = StateUnion<typeof FeeGraph.nodes>;
