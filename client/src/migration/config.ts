/** An ERC-20 migrated to its TIP-20 mirror on Tempo. */
export interface MigrationToken {
    name: string;
    /** The ERC-20 on Ethereum, locked in the token bridge. */
    ethToken: string;
}

export interface MigrationConfig {
    ethereum: {
        rpcUrl: string;
        proofQueue: string;
        /** nori-tempo-sdk's `NoriTokenBridge`: `lockERC20` and `syncPause`. */
        tokenBridge: string;
    };
    tempo: {
        rpcUrl: string;
        /** The `NoriTempoTokenBridge` that proves the queue and mints the mirrors. */
        bridge: string;
    };
    intervals: {
        pollSecs: number;
    };
    stateFile: string;
    tokens: MigrationToken[]; /**
     * Endpoints the sdk probes to tell whether the machine is online (any
     * answer counts). Default: public ones; a local dry run probes its own
     * node, so it runs without internet access.
     */
    network?: { probeUrls?: string[] };
}
