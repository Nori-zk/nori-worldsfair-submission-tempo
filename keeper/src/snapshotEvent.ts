import { define, type StateUnion } from '@yaw-rx/ystate';
import { readThroughConnectionsOf } from '@nori-zk/nori-bridge-tempo-sdk';
import { type SnapshotEvent } from './snapshotWitness.js';

/**
 * A snapshot transaction's `Snapshot` event, read from its receipt through
 * the Ethereum connection (`readThroughConnectionsOf`). A mined receipt
 * never changes, so it is never read again. `event` is `undefined` until
 * read.
 */
export const SnapshotEventGraph = define(readThroughConnectionsOf({ event: undefined as SnapshotEvent | undefined }));

/** The snapshot event's state: a node of the graph and its data. */
export type SnapshotEventState = StateUnion<typeof SnapshotEventGraph.nodes>;
