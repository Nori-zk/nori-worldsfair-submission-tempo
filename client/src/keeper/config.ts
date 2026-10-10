import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { encodeQueryData, queryIdOf } from '@nori-zk/ethereum-snapshot';
import type { GuardConfig } from '../backstop.js';

export interface QueryConfig {
    target: string;
    signature: string;
    args: unknown[];
}

export interface GuardEntry {
    name: string;
    /** The guarded TIP-20 on Tempo. */
    token: string;
    backing: QueryConfig;
    pause?: QueryConfig;
    backingDecimals: number;
    tolerance: string;
    windowSecs: number;
    skewSecs: number;
    checkpointIntervalSecs: number;
    maxStalenessSecs: number;
}

/** An ERC-20 whose TIP-20 mirror on Tempo the keeper keeps paused as it is. */
export interface MirrorEntry {
    name: string;
    /** The ERC-20 on Ethereum, locked in the token bridge. */
    ethToken: string;
}

export interface KeeperConfig {
    ethereum: {
        rpcUrl: string;
        /** The chain `rpcUrl` serves, as a decimal string; the connections check it. */
        chainId: string;
        noriSnapshot: string;
        proofQueue: string;
        /** The `NoriTokenBridge` whose `syncPause` requests each pause proof; needed with `mirrors`. */
        tokenBridge?: string;
    };
    tempo: {
        rpcUrl: string;
        /** The chain `rpcUrl` serves, as a decimal string; the connections check it. */
        chainId: string;
        /** The `NoriTempoTokenBridge` that proves the queue. */
        bridge: string;
        backstop: string;
    };
    intervals: {
        snapshotSecs: number;
        checkpointSecs: number;
        pollSecs: number;
    };
    stateFile: string;
    guards: GuardEntry[];
    mirrors?: MirrorEntry[];
}

/**
 * Loads the repo's .env and the deploy outputs (ethereum/.env.nori-eth-*,
 * tempo/.env.nori-tempo-*). The shell environment wins, then the first file
 * that sets a variable; an empty value counts as unset.
 */
export function loadEnv() {
    for (const file of [
        '.env',
        'ethereum/.env.nori-eth-snapshot',
        'ethereum/.env.nori-eth-demo',
        'tempo/.env.nori-tempo-backstop',
        'tempo/.env.nori-tempo-demo',
    ]) {
        const path = fileURLToPath(
            new URL(`../../../${file}`, import.meta.url)
        );
        if (!existsSync(path)) continue;
        const values = dotenv.parse(readFileSync(path));
        for (const [name, value] of Object.entries(values)) {
            if (!process.env[name]) process.env[name] = value;
        }
    }
}

/**
 * Reads the keeper config, replacing each ${VAR} in its strings with that
 * environment variable. The keys come from ETH_PRIVATE_KEY and
 * TEMPO_PRIVATE_KEY.
 */
export function loadConfig(path: string): KeeperConfig {
    const expand = (value: unknown): unknown => {
        if (typeof value === 'string')
            return value.replace(/\$\{(\w+)\}/g, (_, name: string) => {
                const env = process.env[name];
                if (!env) throw new Error(`Missing env: ${name} (in ${path})`);
                return env;
            });
        if (Array.isArray(value)) return value.map(expand);
        if (value && typeof value === 'object')
            return Object.fromEntries(
                Object.entries(value).map(([key, item]) => [key, expand(item)])
            );
        return value;
    };
    return expand(JSON.parse(readFileSync(path, 'utf8'))) as KeeperConfig;
}

export function queryOf(query: QueryConfig) {
    const data = encodeQueryData(query);
    return {
        target: query.target,
        data,
        queryId: queryIdOf(query.target, data),
    };
}

const NO_QUERY = '0x' + '00'.repeat(32);

export function guardConfigOf(
    config: KeeperConfig,
    guard: GuardEntry
): GuardConfig {
    return {
        noriBridge: config.tempo.bridge,
        noriSnapshot: config.ethereum.noriSnapshot,
        backingQuery: queryOf(guard.backing).queryId,
        pauseQuery: guard.pause ? queryOf(guard.pause).queryId : NO_QUERY,
        backingDecimals: guard.backingDecimals,
        tolerance: BigInt(guard.tolerance),
        windowSecs: guard.windowSecs,
        skewSecs: guard.skewSecs,
        checkpointIntervalSecs: guard.checkpointIntervalSecs,
        maxStalenessSecs: guard.maxStalenessSecs,
    };
}
