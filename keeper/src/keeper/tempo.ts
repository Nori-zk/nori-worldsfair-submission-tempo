import { FetchRequest, isError, JsonRpcProvider, type Interface } from 'ethers';
import { type Connections, createConnections } from '@nori-zk/nori-bridge-tempo-sdk';

/** Any RPC call gives up after this, so a hung connection can't stall the keeper. */
export const RPC_TIMEOUT_MS = 30_000;

/**
 * A JSON-RPC provider whose requests give up after `RPC_TIMEOUT_MS` and that
 * caches no request, so each transaction reads its account's current nonce,
 * also right after another one landed in the same Tempo block.
 */
export function createProvider(rpcUrl: string): JsonRpcProvider {
    const request = new FetchRequest(rpcUrl);
    request.timeout = RPC_TIMEOUT_MS;
    return new JsonRpcProvider(request, undefined, { cacheTimeout: -1 });
}

/**
 * The custom error a contract reverted with: its name when `contract`'s ABI
 * declares it, otherwise the raw revert data. Undefined when the error is not
 * a revert (a transport error, a timeout).
 */
export function contractErrorName(
    error: unknown,
    contract: Interface
): string | undefined {
    if (!isError(error, 'CALL_EXCEPTION')) return undefined;
    if (error.revert) return error.revert.name;
    if (!error.data) return 'revert without data';
    return contract.parseError(error.data)?.name ?? error.data;
}

/** Where a chain is read: its RPC URL and the chain id it must serve, as a decimal string. */
interface ChainConfig {
    rpcUrl: string;
    chainId: string;
}

/** Where the sdk probes for connectivity; local dry runs point it at their own nodes, so they need no internet. */
export interface NetworkConfig {
    probeUrls: string[];
}

/**
 * The sdk's connections to both chains of a config (the keeper's, or the
 * migration's), each checked against its chain id.
 */
export function connectionsOf(config: {
    ethereum: ChainConfig;
    tempo: ChainConfig;
    network?: NetworkConfig;
}): Connections {
    return createConnections({
        ethereum: { expectedChainId: BigInt(config.ethereum.chainId), http: { rpcUrl: config.ethereum.rpcUrl } },
        tempo: { expectedChainId: BigInt(config.tempo.chainId), http: { rpcUrl: config.tempo.rpcUrl } },
        network: config.network,
    });
}
