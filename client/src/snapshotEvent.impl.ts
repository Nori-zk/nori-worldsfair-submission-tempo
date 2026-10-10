import { defer, map, NEVER } from 'rxjs';
import {
    dueOn,
    startReadThroughConnectionsMachine,
    type ProofRequestConnections,
} from '@nori-zk/nori-bridge-tempo-sdk';
import { SnapshotEventGraph } from './snapshotEvent.js';
import { parseSnapshotEvent } from './snapshotWitness.js';

/**
 * Starts reading a mined snapshot transaction's `Snapshot` event through
 * the Ethereum connection. A transaction with no receipt yet is a failed
 * read, retried by the machine.
 *
 * @param connections The Ethereum and Tempo chains, from `createConnections`.
 * @param noriSnapshot The `NoriSnapshot` that emitted the event.
 * @param snapshotTxHash The transaction that called `NoriSnapshot.snapshot`.
 * @returns The running machine; `current` carries `event`. Its controls:
 *   - `retry()`: reads again now, without waiting, while failed.
 *   - `close()`: moves the machine to `closed`.
 */
export const createSnapshotEventMachine = (
    connections: ProofRequestConnections,
    noriSnapshot: string,
    snapshotTxHash: string
) =>
    startReadThroughConnectionsMachine(SnapshotEventGraph, {
        connections,
        read: (clients) =>
            clients
                .ethereum((provider) => defer(() => provider.getTransactionReceipt(snapshotTxHash)))
                .pipe(
                    map((receipt) => {
                        if (!receipt) throw new Error(`No receipt for ${snapshotTxHash}`);
                        return { event: parseSnapshotEvent(receipt, noriSnapshot) };
                    })
                ),
        // A mined receipt never changes: following at once, never read again.
        refreshOn: () => dueOn(NEVER),
        needs: ['ethereum'],
    });
