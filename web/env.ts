import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { getAddress } from 'ethers';

/** The constants every app and dashboard under web/ is built with. */
export interface WebEnv {
    ethereum: {
        /** The chain the wallet must be on. */
        chainId: number;
        /** A public Ethereum RPC for reads, tried before the wallet. */
        rpcUrl: string;
        /** The `NoriProofRequestQueue` address. */
        proofQueueAddress: string;
        /** The first block to read proof requests from: the queue's deploy block. */
        proofQueueDeployBlock: number;
        /** The `NoriSnapshot` address. */
        snapshotAddress: string;
        /** The `NoriTokenBridge` holders lock ERC-20s in, or `''` where no app needs it (the migrate app does). */
        tokenBridgeAddress: string;
    };
    tempo: {
        /** The Tempo chain the reads expect. */
        chainId: number;
        /** Tempo's http RPC, for calls and logs. */
        rpcUrl: string;
        /** Tempo's websocket RPC, for subscriptions. */
        wssUrl: string;
        /** The `NoriTempoTokenBridge` that commits proof queue batches. */
        bridgeAddress: string;
    };
    bridge: {
        /** The bridge's websocket, for the live processing stages. */
        wssUrl: string;
    };
    migration: {
        /** The Ethereum ERC-20 the migrate app moves to its TIP-20 on Tempo, or `''` where no app needs it. */
        token: string;
    };
    /** Each app's and dashboard's address, for the links along the top of every page. */
    urls: {
        proveBalance: string;
        /** The migrate app, or `''` to leave its link out. */
        migrate: string;
        dashboard: string;
        /** The Solana submission's bridge dashboard, or `''` to leave its link out. */
        solanaDashboard: string;
    };
}

/** Thrown when a web/ build constant is missing or malformed. */
export class WebEnvError extends Error {
    /**
     * @param name The variable's name.
     * @param reason What is wrong with it.
     */
    constructor(name: string, reason: string) {
        super(`web/.env: ${name} ${reason}`);
    }
}

/**
 * Reads the build constants from the shell environment, then web/.env (the
 * shell wins; an empty value counts as unset), and checks each one.
 *
 * Only the names read here reach a browser: the result is built into the
 * page as `NORI_WEB_ENV`.
 *
 * @returns The checked constants.
 * @throws WebEnvError When a constant is missing or malformed.
 */
export function loadWebEnv(): WebEnv {
    const path = fileURLToPath(new URL('.env', import.meta.url));
    const file = existsSync(path) ? dotenv.parse(readFileSync(path)) : {};
    const read = (name: string): string => {
        const value = process.env[name] || file[name];
        if (!value) throw new WebEnvError(name, 'is not set');
        return value;
    };
    const readInteger = (name: string): number => {
        const value = Number(read(name));
        if (!Number.isSafeInteger(value) || value < 0)
            throw new WebEnvError(name, 'is not a non-negative integer');
        return value;
    };
    const readEthAddress = (name: string): string => {
        try {
            return getAddress(read(name));
        } catch (error) {
            if (error instanceof WebEnvError) throw error;
            throw new WebEnvError(name, 'is not an EVM address');
        }
    };
    const readOptionalEthAddress = (name: string): string =>
        process.env[name] || file[name] ? readEthAddress(name) : '';
    const readUrl = (name: string, schemes: RegExp, expected: string): string => {
        const url = read(name);
        if (!schemes.test(url)) throw new WebEnvError(name, `is not ${expected}`);
        return url;
    };
    const HTTP = /^https?:\/\//;
    const WS = /^wss?:\/\//;

    return {
        ethereum: {
            chainId: readInteger('ETH_CHAIN_ID'),
            rpcUrl: readUrl('ETH_RPC_URL', HTTP, 'an http:// or https:// URL'),
            proofQueueAddress: readEthAddress('NORI_ETH_PROOF_QUEUE_ADDRESS'),
            proofQueueDeployBlock: readInteger('NORI_WEB_PROOF_QUEUE_DEPLOY_BLOCK'),
            snapshotAddress: readEthAddress('NORI_ETH_SNAPSHOT_ADDRESS'),
            tokenBridgeAddress: readOptionalEthAddress('NORI_ETH_TOKEN_BRIDGE_ADDRESS'),
        },
        tempo: {
            chainId: readInteger('TEMPO_CHAIN_ID'),
            rpcUrl: readUrl('TEMPO_RPC_NETWORK_URL', HTTP, 'an http:// or https:// URL'),
            wssUrl: readUrl('TEMPO_WSS_NETWORK_URL', WS, 'a ws:// or wss:// URL'),
            bridgeAddress: readEthAddress('NORI_TEMPO_TOKEN_BRIDGE_ADDRESS'),
        },
        bridge: {
            wssUrl: readUrl('NORI_WEB_BRIDGE_WSS_URL', WS, 'a ws:// or wss:// URL'),
        },
        migration: {
            token: readOptionalEthAddress('NORI_WEB_MIGRATION_TOKEN'),
        },
        urls: {
            proveBalance: readUrl('NORI_WEB_PROVE_BALANCE_URL', HTTP, 'an http:// or https:// URL'),
            // Optional; empty in the shell wins over web/.env's dev server, so a host can leave the link out
            migrate:
                (process.env.NORI_WEB_MIGRATE_URL ?? file.NORI_WEB_MIGRATE_URL)
                    ? readUrl('NORI_WEB_MIGRATE_URL', HTTP, 'an http:// or https:// URL')
                    : '',
            dashboard: readUrl('NORI_WEB_DASHBOARD_URL', HTTP, 'an http:// or https:// URL'),
            solanaDashboard:
                process.env.NORI_WEB_SOLANA_DASHBOARD_URL || file.NORI_WEB_SOLANA_DASHBOARD_URL
                    ? readUrl('NORI_WEB_SOLANA_DASHBOARD_URL', HTTP, 'an http:// or https:// URL')
                    : '',
        },
    };
}
