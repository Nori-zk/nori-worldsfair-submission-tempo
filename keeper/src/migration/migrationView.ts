import { define, type StateUnion } from '@yaw-rx/ystate';
import { readThroughConnectionsOf } from '@nori-zk/nori-bridge-tempo-sdk';

/** One ERC-20's migration on both chains, for one holder on Ethereum and one recipient on Tempo. */
export interface MigrationView {
    symbol: string;
    decimals: bigint;
    /** The ERC-20's `paused()`: its issuer's pause. */
    erc20Paused: boolean;
    /** The holder's balance of the ERC-20, and what it allows the token bridge to take. */
    balance: bigint;
    allowance: bigint;
    /** `NoriTokenBridge.totalLockedERC20BU`: locked for every recipient, in bridge units (a TIP-20's 6 decimals). */
    totalLocked: bigint;
    /** `NoriTokenBridge.lockedERC20` for the recipient, in bridge units. */
    lockedForRecipient: bigint;
    /** Its TIP-20 mirror on Tempo, `undefined` while none is registered or adopted. */
    mirror: string | undefined;
    mirrorPaused: boolean | undefined;
    /** `NoriTempoTokenBridge.erc20TotalMinted`: minted to every recipient; never more than `totalLocked`. */
    totalMinted: bigint;
    /** `NoriTempoTokenBridge.erc20MintedSoFar` for the recipient. */
    mintedToRecipient: bigint;
    /** The recipient's balance of the mirror. */
    recipientBalance: bigint;
}

/**
 * One ERC-20's migration, read through both connections
 * (`readThroughConnectionsOf`): read at once, then again on each Ethereum
 * block and each log of the Tempo bridge. `migration` is `undefined` until
 * read.
 */
export const MigrationGraph = define(readThroughConnectionsOf({ migration: undefined as MigrationView | undefined }));

/** The migration's state: a node of the graph and its data. */
export type MigrationState = StateUnion<typeof MigrationGraph.nodes>;
