import { define, type StateUnion } from '@yaw-rx/ystate';
import { readThroughConnectionsOf } from '@nori-zk/nori-bridge-tempo-sdk';

/** An ERC-20's pause state on both chains. */
export interface MirrorPauseView {
    /** The ERC-20's `paused()` on Ethereum. */
    erc20Paused: boolean;
    /** The pause state `NoriTokenBridge` last synced for it (`PAUSE_STATE_PAUSED`, `PAUSE_STATE_UNPAUSED`, or 0 for never). */
    synced: bigint;
    /** Its TIP-20 mirror on Tempo, `undefined` while none is registered. */
    mirror: string | undefined;
    /** The mirror's `paused()`, `undefined` while none is registered. */
    mirrorPaused: boolean | undefined;
}

/**
 * One mirrored ERC-20's pause state, read through both connections
 * (`readThroughConnectionsOf`): read at once, then again on each Ethereum
 * block and each log of the Tempo bridge. `pause` is `undefined` until read.
 */
export const MirrorPauseGraph = define(readThroughConnectionsOf({ pause: undefined as MirrorPauseView | undefined }));

/** The mirror's pause state: a node of the graph and its data. */
export type MirrorPauseState = StateUnion<typeof MirrorPauseGraph.nodes>;
