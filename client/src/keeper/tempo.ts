import { FetchRequest, isError, JsonRpcProvider, type Interface } from 'ethers';

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
