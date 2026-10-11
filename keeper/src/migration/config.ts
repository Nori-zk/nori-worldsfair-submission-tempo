import type { NetworkConfig } from '../keeper/tempo.js';

/** An Ethereum ERC-20 migrated to its TIP-20 mirror on Tempo. */
export interface TokenEntry {
    name: string;
    /** The ERC-20 on Ethereum, locked in the token bridge. */
    ethToken: string;
}

/** The migration CLI's config: both Nori bridges and the ERC-20s it migrates. */
export interface MigrationConfig {
    ethereum: {
        rpcUrl: string;
        /** The chain `rpcUrl` serves, as a decimal string; the connections check it. */
        chainId: string;
        /** The `NoriProofRequestQueue` the token bridge enqueues on. */
        proofQueue: string;
        /** The `NoriTokenBridge` holders lock in. */
        tokenBridge: string;
    };
    tempo: {
        rpcUrl: string;
        /** The chain `rpcUrl` serves, as a decimal string; the connections check it. */
        chainId: string;
        /** The `NoriTempoTokenBridge` that proves the queue and mints each mirror. */
        bridge: string;
    };
    intervals: {
        pollSecs: number;
    };
    stateFile: string;
    tokens: TokenEntry[];
    /** Where the sdk probes for connectivity (default: public endpoints). */
    network?: NetworkConfig;
}
