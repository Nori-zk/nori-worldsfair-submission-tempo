import { defer, map } from 'rxjs';
import {
    changesOf$,
    createChainChangesMachine,
    type EthereumProvider,
    type ProofRequestConnections,
    startReadThroughConnectionsMachine,
} from '@nori-zk/nori-bridge-tempo-sdk';
import { FeeGraph } from './fee.js';

/**
 * Starts reading a fee an Ethereum contract charges through the Ethereum
 * connection, reading it again on each log of the contract.
 *
 * @param connections The Ethereum and Tempo chains, from `createConnections`.
 * @param contract The contract that charges it.
 * @param readFee The contract's fee getter, given the provider.
 * @returns The running machine; `current` carries `fee`, in wei. Its controls:
 *   - `retry()`: reads again now, without waiting, while failed.
 *   - `close()`: moves the machine to `closed`.
 */
export const createFeeMachine = (
    connections: ProofRequestConnections,
    contract: string,
    readFee: (provider: EthereumProvider) => Promise<bigint>
) => {
    const contractLogs = createChainChangesMachine(connections.ethereum, { address: contract });
    return startReadThroughConnectionsMachine(FeeGraph, {
        connections,
        read: (clients) =>
            clients.ethereum((provider) => defer(async () => readFee(provider))).pipe(map((fee) => ({ fee }))),
        refreshOn: () => changesOf$(contractLogs),
        needs: ['ethereum'],
        owns: [contractLogs],
    });
};
