import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SNAPSHOT_COLLECTION_KEYS } from '@nori-zk/tempo-backstop';
import {
    snapshotResultWitness,
    type SnapshotEvent,
} from './snapshotWitness.js';

interface VectorSnapshot {
    snapshotIndex: number;
    requestId: number;
    blockNumber: number;
    timestamp: number;
    resultsRoot: string;
    results: Array<{
        name: string;
        queryId: string;
        result: string;
        index: number;
        path: string[];
    }>;
}
interface Vectors {
    noriSnapshot: string;
    batch: { root: string };
    requests: Array<{
        requestId: number;
        index: number;
        value: string;
        leaf: string;
        path: string[];
    }>;
    snapshots: VectorSnapshot[];
}

const vectors: Vectors = JSON.parse(
    readFileSync(
        new URL(
            '../../test-vectors/nori-snapshot/kelp-replay-vectors.json',
            import.meta.url
        ),
        'utf8'
    )
);

function eventOf(snapshot: VectorSnapshot): SnapshotEvent {
    return {
        snapshotIndex: BigInt(snapshot.snapshotIndex),
        requestId: BigInt(snapshot.requestId),
        blockNumber: BigInt(snapshot.blockNumber),
        timestamp: BigInt(snapshot.timestamp),
        resultsRoot: snapshot.resultsRoot,
        queryIds: snapshot.results.map((r) => r.queryId),
        results: snapshot.results.map((r) => r.result),
    };
}

function requestWitnessOf(requestId: number) {
    const request = vectors.requests.find((r) => r.requestId === requestId);
    assert.ok(request);
    return {
        root: vectors.batch.root,
        index: request.index,
        leaf: request.leaf,
        path: request.path,
    };
}

test('rebuilds the drained snapshot witness from its event and batch path', () => {
    const drained = vectors.snapshots[1];
    assert.ok(drained);
    const balance = drained.results.find((r) => r.name === 'lockbox-balance');
    assert.ok(balance);
    const request = vectors.requests.find(
        (r) => r.requestId === drained.requestId
    );
    assert.ok(request);

    const witness = snapshotResultWitness(
        vectors.noriSnapshot,
        eventOf(drained),
        balance.queryId,
        requestWitnessOf(drained.requestId)
    );

    assert.deepEqual(witness.request.path, request.path);
    assert.equal(witness.request.index, BigInt(request.index));
    assert.equal(witness.request.value.target, vectors.noriSnapshot);
    assert.equal(
        witness.request.value.collectionKeysCount,
        SNAPSHOT_COLLECTION_KEYS
    );
    assert.equal(witness.request.value.value, BigInt(request.value));
    assert.equal(witness.resultIndex, balance.index);
    assert.deepEqual(witness.resultPath, balance.path);
    assert.equal(witness.result, balance.result);
});

test('refuses a batch path that belongs to another snapshot', () => {
    const [healthy, drained] = vectors.snapshots;
    assert.ok(healthy && drained);
    const queryId = drained.results[0]?.queryId ?? '';

    assert.throws(
        () =>
            snapshotResultWitness(
                vectors.noriSnapshot,
                eventOf(drained),
                queryId,
                requestWitnessOf(healthy.requestId)
            ),
        /not for this snapshot/
    );
    assert.throws(
        () =>
            snapshotResultWitness(
                vectors.noriSnapshot,
                eventOf(drained),
                '0x' + '00'.repeat(32),
                requestWitnessOf(drained.requestId)
            ),
        /not in this snapshot/
    );
});
