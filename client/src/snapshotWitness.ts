import { Interface, toBeHex, type TransactionReceipt } from 'ethers';
import {
    commitmentWordOf,
    noriSnapshotJson,
    resultWitnessOf,
    timeKeyOf,
} from '@nori-zk/ethereum-snapshot';
import {
    request_leaf_hash,
    type RequestLeaf,
    type RequestWitness,
} from '@nori-zk/ethereum-tempo-proof-queue-utils-glam';
import { SNAPSHOT_COLLECTION_KEYS } from '@nori-zk/tempo-backstop';

const snapshotInterface = new Interface(noriSnapshotJson.abi);

/** A NoriSnapshot `Snapshot` event: everything needed to rebuild witnesses. */
export interface SnapshotEvent {
    snapshotIndex: bigint;
    requestId: bigint;
    blockNumber: bigint;
    timestamp: bigint;
    resultsRoot: string;
    queryIds: string[];
    results: string[];
}

/**
 * `NoriRead.SnapshotResultWitness`, as `Backstop.submitRead` and
 * `NoriReadExample.readSnapshotResult` take it.
 */
export interface SnapshotResultWitnessArgs {
    request: {
        path: string[];
        index: bigint;
        value: {
            target: string;
            collectionKeysCount: number;
            collectionKeys: [string, string];
            value: bigint;
        };
    };
    result: string;
    resultIndex: number;
    resultPath: string[];
}

/** Reads the `Snapshot` event that `noriSnapshot` emitted in `receipt`. */
export function parseSnapshotEvent(
    receipt: TransactionReceipt,
    noriSnapshot: string
): SnapshotEvent {
    for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== noriSnapshot.toLowerCase()) continue;
        const parsed = snapshotInterface.parseLog(log);
        if (parsed?.name !== 'Snapshot') continue;
        return {
            snapshotIndex: parsed.args.snapshotIndex,
            requestId: parsed.args.requestId,
            blockNumber: parsed.args.blockNumber,
            timestamp: parsed.args.timestamp,
            resultsRoot: parsed.args.resultsRoot,
            queryIds: [...parsed.args.queryIds],
            results: [...parsed.args.results],
        };
    }
    throw new Error(
        `No Snapshot event from ${noriSnapshot} in ${receipt.hash}`
    );
}

/** The snapshot's proof request leaf, as the queue and NoriSnapshot's storage hold it. */
export function snapshotLeaf(
    noriSnapshot: string,
    event: SnapshotEvent
): RequestLeaf {
    return {
        target: noriSnapshot,
        collectionKeysCount: SNAPSHOT_COLLECTION_KEYS,
        collectionKeys: [
            toBeHex(event.snapshotIndex, 32),
            timeKeyOf(event.blockNumber, event.timestamp),
        ],
        value: toBeHex(commitmentWordOf(event.resultsRoot), 32),
    };
}

/**
 * Combines the request's path in its proof queue batch (from the sdk's
 * `fetchProofRequestWitness`) with the result's path in the snapshot, for
 * the result of `queryId`.
 */
export function snapshotResultWitness(
    noriSnapshot: string,
    event: SnapshotEvent,
    queryId: string,
    requestWitness: RequestWitness
): SnapshotResultWitnessArgs {
    const leaf = snapshotLeaf(noriSnapshot, event);
    if (request_leaf_hash(leaf) !== requestWitness.leaf) {
        throw new Error('The batch witness is not for this snapshot');
    }
    const resultIndex = event.queryIds.findIndex(
        (id) => id.toLowerCase() === queryId.toLowerCase()
    );
    if (resultIndex < 0)
        throw new Error(`Query ${queryId} is not in this snapshot`);
    const result = resultWitnessOf(event.queryIds, event.results, resultIndex);
    const [key0, key1] = leaf.collectionKeys;
    if (!key0 || !key1)
        throw new Error('A snapshot leaf has two collection keys');

    return {
        request: {
            path: [...requestWitness.path],
            index: BigInt(requestWitness.index),
            value: {
                target: noriSnapshot,
                collectionKeysCount: SNAPSHOT_COLLECTION_KEYS,
                collectionKeys: [key0, key1],
                value: BigInt(leaf.value),
            },
        },
        result: event.results[resultIndex] ?? '0x',
        resultIndex,
        resultPath: result.path,
    };
}
