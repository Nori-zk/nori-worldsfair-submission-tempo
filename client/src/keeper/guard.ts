import { define, type StateUnion } from '@yaw-rx/ystate';
import { readThroughConnectionsOf } from '@nori-zk/nori-bridge-tempo-sdk';

/** A guard as `Backstop.guard` holds it, with its status and its token's supply. */
export interface GuardView {
    backing: bigint;
    backingEthBlock: bigint;
    paused: boolean;
    tripped: boolean;
    tripEthBlock: bigint;
    tripDeficit: bigint;
    /** `Backstop.status`, named by `guardStatusName`. */
    status: bigint;
    /** The guarded token's total supply. */
    supply: bigint;
}

/**
 * One guard the keeper administers, read from the Backstop on Tempo through
 * the Tempo connection (`readThroughConnectionsOf`): read at once, then
 * again on each Backstop log and every poll interval, as its status moves
 * with time. `guardId` is `''` and `guard` `undefined` until read; `guard`
 * stays `undefined` while the guard does not exist.
 */
export const GuardGraph = define(
    readThroughConnectionsOf({ guardId: '', guard: undefined as GuardView | undefined })
);

/** The guard's state: a node of the graph and its data. */
export type GuardState = StateUnion<typeof GuardGraph.nodes>;
