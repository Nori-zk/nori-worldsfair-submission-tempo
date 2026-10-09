/// <reference types="@nomicfoundation/hardhat-ethers" />
/// <reference types="@nomicfoundation/hardhat-ethers-chai-matchers" />
// NoriRead against test-vectors/nori-snapshot, generated from the
// NoriSnapshot and NoriProofRequestQueue contracts with the sdk's hashing
// wasm (`npm run vectors -w ethereum`), and against witnesses forged from them.
import { expect } from 'chai';
import {
    commitmentWordOf,
    resultLeafOf,
    timeKeyOf,
} from '@nori-zk/ethereum-snapshot';
import {
    MAX_U64,
    type NoriTempoTokenBridge,
} from '@nori-zk/tempo-token-bridge';
import {
    MAX_RESULT_PATH,
    MAX_TREE_DEPTH,
    SENTINEL,
    SNAPSHOT_COLLECTION_KEYS,
} from '../contracts/NoriRead.const.js';
import {
    NoriReadHarness__factory,
    type NoriReadHarness,
} from '../types/ethers-contracts/index.js';
import {
    batchOf,
    deployNoriBridge,
    ethers,
    kelpReplayVectors,
    localVectors,
    mainnetVectors,
    plantProofQueueBatches,
    requestOf,
    requestWitnessOf,
    resultOf,
    resultsOf,
    type VectorResult,
    type Vectors,
} from './helpers.js';

/** Snapshot index 1. */
const INDEX_KEY_1 = ethers.toBeHex(1n, 32);
const TIME_KEY_BLOCK = 10n;
const TIME_KEY_TIMESTAMP = 1_784_621_632n;
const TIME_KEY = timeKeyOf(TIME_KEY_BLOCK, TIME_KEY_TIMESTAMP);

const all = () => [localVectors(), mainnetVectors(), kelpReplayVectors()];

/** Result 1 (`isPaused`) of the five-query snapshot: a three-level path. */
function fiveQueryResult(vectors: Vectors): VectorResult {
    const found = resultsOf(vectors).find(
        (vector) =>
            vector.snapshot.results.length === 5 && vector.result.index === 1
    );
    if (!found) throw new Error('No result 1 of the five-query snapshot');
    return found;
}

/** The commitment of a one-result snapshot, whose results root is its one leaf. */
const commitmentOfOne = (queryId: string, result: string) =>
    commitmentWordOf(resultLeafOf(queryId, result));

describe('NoriRead', () => {
    let bridge: NoriTempoTokenBridge;
    let harness: NoriReadHarness;

    before(async () => {
        bridge = await deployNoriBridge(localVectors().proofQueue);
        const [deployer] = await ethers.getSigners();
        harness = await new NoriReadHarness__factory(deployer).deploy();
        await harness.waitForDeployment();
    });

    const verify = (
        batch: ReturnType<typeof batchOf>,
        noriSnapshot: string,
        queryId: string,
        witness: VectorResult['witness']
    ) =>
        harness.verifySnapshotResult(
            bridge,
            batch,
            noriSnapshot,
            queryId,
            witness
        );

    /**
     * A batch of one snapshot leaf whose results tree holds one result,
     * built here rather than by the contracts, for leaves the contracts never
     * write.
     */
    async function singleLeafBatch(
        noriSnapshot: string,
        keys: [string, string],
        committed: bigint
    ) {
        const request = {
            path: [] as string[],
            index: 0n,
            value: {
                target: noriSnapshot,
                collectionKeysCount: SNAPSHOT_COLLECTION_KEYS,
                collectionKeys: keys,
                value: committed,
            },
        };
        const batch = {
            root: await bridge.requestLeafHash(request.value),
            outputBlockNumber: 100n,
            inputQueueCursor: 5n,
            outputQueueCursor: 6n,
            tempoBlockNumber: 0n,
        };
        return { batch, request };
    }

    describe('the vectors themselves', () => {
        it('request leaves hash like the Nori bridge and reach the batch root', async () => {
            for (const vectors of all()) {
                for (const request of vectors.requests) {
                    const witness = requestWitnessOf(
                        vectors,
                        request.requestId
                    );
                    expect(
                        await bridge.requestLeafHash(witness.value)
                    ).to.equal(request.leaf);
                    expect(
                        await bridge.verifiedRequestWitnessRoot(witness)
                    ).to.equal(vectors.batch.root);
                }
            }
        });

        it('every snapshot result verifies with its index, block and time', async () => {
            for (const vectors of all()) {
                const results = resultsOf(vectors);
                expect(results).to.not.have.lengthOf(0);
                for (const vector of results) {
                    const proven = await verify(
                        batchOf(vectors),
                        vectors.noriSnapshot,
                        vector.queryId,
                        vector.witness
                    );
                    expect(proven.queryId, vector.result.name).to.equal(
                        vector.queryId
                    );
                    expect(proven.result, vector.result.name).to.equal(
                        vector.result.result
                    );
                    expect(proven.snapshotIndex).to.equal(
                        BigInt(vector.snapshot.snapshotIndex)
                    );
                    expect(proven.requestId).to.equal(
                        BigInt(vector.snapshot.requestId)
                    );
                    expect(proven.ethBlockNumber).to.equal(
                        BigInt(vector.snapshot.blockNumber)
                    );
                    expect(proven.ethTimestamp).to.equal(
                        BigInt(vector.snapshot.timestamp)
                    );
                    expect(proven.provenBlockNumber).to.equal(
                        BigInt(vectors.batch.outputBlockNumber)
                    );
                }
            }
        });

        it('query ids match the contract', async () => {
            for (const vectors of all()) {
                for (const vector of resultsOf(vectors)) {
                    expect(
                        await harness.queryIdOf(
                            vector.result.target,
                            vector.result.data
                        ),
                        vector.result.name
                    ).to.equal(vector.queryId);
                }
            }
        });

        it('reads real mainnet backing and pause flags', async () => {
            const vectors = mainnetVectors();
            const read = async (name: string) => {
                const vector = resultOf(vectors, name);
                return verify(
                    batchOf(vectors),
                    vectors.noriSnapshot,
                    vector.queryId,
                    vector.witness
                );
            };
            // A call's result is read-only, so the struct is passed back as a new object
            const asBool = async (name: string) => {
                const {
                    queryId,
                    result,
                    snapshotIndex,
                    requestId,
                    ethBlockNumber,
                    ethTimestamp,
                    provenBlockNumber,
                } = await read(name);
                return harness.resultBool({
                    queryId,
                    result,
                    snapshotIndex,
                    requestId,
                    ethBlockNumber,
                    ethTimestamp,
                    provenBlockNumber,
                });
            };

            expect(
                BigInt((await read('usds-lockbox')).result)
            ).to.be.greaterThan(0n);
            expect([...(await asBool('usds-lockbox-paused'))]).to.deep.equal([
                true,
                false,
            ]);
            expect([...(await asBool('aave-ntt-hub-paused'))]).to.deep.equal([
                true,
                false,
            ]);
            // Wormhole custody (18 decimals) covers what it bridged out (8 decimals)
            const outstanding = BigInt(
                (await read('wormhole-weth-outstanding')).result
            );
            const custody = BigInt(
                (await read('wormhole-weth-custody')).result
            );
            expect(custody >= outstanding * 10n ** 10n).to.equal(true);
            expect(
                BigInt((await read('wormhole-wbtc-outstanding')).result) <=
                    MAX_U64
            ).to.equal(true);
        });
    });

    describe('forged and malformed witnesses', () => {
        it('rejects a result for another query', async () => {
            const vectors = localVectors();
            const { witness } = fiveQueryResult(vectors);
            const otherQuery = vectors.snapshots[1].results[0].queryId;
            await expect(
                verify(
                    batchOf(vectors),
                    vectors.noriSnapshot,
                    otherQuery,
                    witness
                )
            ).to.be.revertedWithCustomError(harness, 'ResultRootMismatch');
        });

        it('rejects a tampered result, index or path', async () => {
            const vectors = localVectors();
            const { witness, queryId } = fiveQueryResult(vectors);
            const check = (edited: VectorResult['witness']) =>
                verify(batchOf(vectors), vectors.noriSnapshot, queryId, edited);
            await check(witness);

            const tampered = ethers.getBytes(witness.result);
            tampered[31] ^= 1;
            await expect(
                check({ ...witness, result: ethers.hexlify(tampered) })
            ).to.be.revertedWithCustomError(harness, 'ResultRootMismatch');
            await expect(
                check({ ...witness, resultIndex: 0 })
            ).to.be.revertedWithCustomError(harness, 'ResultRootMismatch');

            const wrongSibling = [...witness.resultPath];
            const sibling = ethers.getBytes(wrongSibling[2]);
            sibling[0] ^= 1;
            wrongSibling[2] = ethers.hexlify(sibling);
            await expect(
                check({ ...witness, resultPath: wrongSibling })
            ).to.be.revertedWithCustomError(harness, 'ResultRootMismatch');
            await expect(
                check({
                    ...witness,
                    resultPath: witness.resultPath.slice(0, -1),
                })
            ).to.be.revertedWithCustomError(harness, 'ResultRootMismatch');

            // A three-level path holds indices 0..8
            await expect(check({ ...witness, resultIndex: 8 }))
                .to.be.revertedWithCustomError(harness, 'ResultIndex')
                .withArgs(8, 3);
            await expect(
                check({
                    ...witness,
                    resultPath: Array(MAX_RESULT_PATH + 1).fill(
                        '0x' + '07'.repeat(32)
                    ),
                })
            )
                .to.be.revertedWithCustomError(harness, 'ResultPathTooLong')
                .withArgs(MAX_RESULT_PATH + 1);
        });

        it('rejects another NoriSnapshot and leaves that are not snapshots', async () => {
            const vectors = localVectors();
            const batch = batchOf(vectors);
            const { witness, queryId } = fiveQueryResult(vectors);

            const impostor = '0x' + '11'.repeat(20);
            await expect(verify(batch, impostor, queryId, witness))
                .to.be.revertedWithCustomError(harness, 'NotNoriSnapshot')
                .withArgs(ethers.getAddress(vectors.noriSnapshot));

            // Request 1 is an account proving its own empty storage
            const foreign = {
                ...witness,
                request: requestWitnessOf(vectors, 1),
            };
            const foreignTarget = ethers.getAddress(
                requestOf(vectors, 1).target
            );
            await expect(verify(batch, vectors.noriSnapshot, queryId, foreign))
                .to.be.revertedWithCustomError(harness, 'NotNoriSnapshot')
                .withArgs(foreignTarget);
            // Even a consumer misconfigured to trust that account learns nothing
            await expect(verify(batch, foreignTarget, queryId, foreign))
                .to.be.revertedWithCustomError(harness, 'CollectionKeysCount')
                .withArgs(0);
        });

        it('rejects a request not in the batch', async () => {
            const local = localVectors();
            const mainnet = mainnetVectors();
            const { witness, queryId } = fiveQueryResult(local);

            // The same witness against another batch's root
            await expect(
                verify(batchOf(mainnet), local.noriSnapshot, queryId, witness)
            ).to.be.revertedWithCustomError(harness, 'BatchRootMismatch');

            // A batch whose cursor range ends before the request's index (2)
            const shortBatch = { ...batchOf(local) };
            shortBatch.outputQueueCursor = shortBatch.inputQueueCursor + 2n;
            await expect(
                verify(shortBatch, local.noriSnapshot, queryId, witness)
            )
                .to.be.revertedWithCustomError(
                    harness,
                    'RequestIndexOutsideBatch'
                )
                .withArgs(2, 2);

            const malformed = {
                ...witness,
                request: {
                    ...witness.request,
                    path: Array(MAX_TREE_DEPTH + 1).fill(ethers.ZeroHash),
                },
            };
            await expect(
                verify(batchOf(local), local.noriSnapshot, queryId, malformed)
            ).to.be.revertedWithCustomError(harness, 'RequestWitness');
        });

        it('rejects proven words without the sentinel', async () => {
            const noriSnapshot = '0x' + '22'.repeat(20);
            const pinned = '0x' + '33'.repeat(32);
            const result = '0x' + '44'.repeat(32);
            const uncommitted = commitmentOfOne(pinned, result) & ~SENTINEL;

            // A false zero (an exclusion proof for an unwritten slot) and a
            // word whose root matches but lacks the top bit
            for (const proven of [0n, uncommitted]) {
                const { batch, request } = await singleLeafBatch(
                    noriSnapshot,
                    [INDEX_KEY_1, TIME_KEY],
                    proven
                );
                await expect(
                    verify(batch, noriSnapshot, pinned, {
                        request,
                        result,
                        resultIndex: 0,
                        resultPath: [],
                    })
                ).to.be.revertedWithCustomError(harness, 'MissingSentinel');
            }
        });

        it('reads index and time keys, and rejects keys NoriSnapshot never writes', async () => {
            const noriSnapshot = '0x' + '22'.repeat(20);
            const pinned = '0x' + '33'.repeat(32);
            const result = '0x' + '44'.repeat(32);
            const committed = commitmentOfOne(pinned, result);
            const witnessFor = (
                request: Awaited<ReturnType<typeof singleLeafBatch>>['request']
            ) => ({
                request,
                result,
                resultIndex: 0,
                resultPath: [] as string[],
            });

            const indexKey = ethers.toBeHex(9n, 32);
            const { batch, request } = await singleLeafBatch(
                noriSnapshot,
                [indexKey, TIME_KEY],
                committed
            );
            const proven = await verify(
                batch,
                noriSnapshot,
                pinned,
                witnessFor(request)
            );
            expect(proven.snapshotIndex).to.equal(9n);
            expect(proven.requestId).to.equal(5n);
            expect(proven.ethBlockNumber).to.equal(TIME_KEY_BLOCK);
            expect(proven.ethTimestamp).to.equal(TIME_KEY_TIMESTAMP);
            expect(proven.provenBlockNumber).to.equal(100n);

            // Keys NoriSnapshot never writes, as a false zero from the proving
            // side would make them: index 0, an index beyond 64 bits, a zero
            // or wide time key
            const wideIndex = ethers.toBeHex(9n | (MAX_U64 + 1n), 32);
            const wideTime = timeKeyOf(
                TIME_KEY_BLOCK | (MAX_U64 + 1n),
                TIME_KEY_TIMESTAMP
            );
            const cases: Array<[[string, string], string]> = [
                [[ethers.ZeroHash, TIME_KEY], 'SnapshotIndex'],
                [[wideIndex, TIME_KEY], 'SnapshotIndex'],
                [[indexKey, ethers.ZeroHash], 'TimeKey'],
                [[indexKey, wideTime], 'TimeKey'],
            ];
            for (const [keys, error] of cases) {
                const single = await singleLeafBatch(
                    noriSnapshot,
                    keys,
                    committed
                );
                await expect(
                    verify(
                        single.batch,
                        noriSnapshot,
                        pinned,
                        witnessFor(single.request)
                    )
                ).to.be.revertedWithCustomError(harness, error);
            }
        });

        it('rejects an attacker result presented as a node one level up', async () => {
            // Request 4 snapshots the identity precompile, whose result the
            // attacker chose: sha256(queryId(value()) ++ 2^200), an unprefixed
            // node over a forged value() result
            const vectors = localVectors();
            const batch = batchOf(vectors);
            const identity = resultOf(vectors, 'identity-forgery');
            const value = resultsOf(vectors)[0];
            expect(value.result.name).to.equal('value');
            const forgedResult = ethers.toBeHex(1n << 200n, 32);

            // The genuine result verifies
            await verify(
                batch,
                vectors.noriSnapshot,
                identity.queryId,
                identity.witness
            );

            // value() = 2^200 at index 1 under sibling queryId(identity): the
            // unprefixed tree would accept it, the prefixed one does not
            expect(
                ethers.sha256(ethers.concat([value.queryId, forgedResult]))
            ).to.equal(
                identity.result.result,
                'the vector holds the unprefixed node'
            );
            const forged = {
                ...identity.witness,
                result: forgedResult,
                resultIndex: 1,
                resultPath: [identity.queryId],
            };
            await expect(
                verify(batch, vectors.noriSnapshot, value.queryId, forged)
            ).to.be.revertedWithCustomError(harness, 'ResultRootMismatch');
        });
    });

    describe('reading the Nori bridge', () => {
        it('loads only the batches the trusted bridge committed', async () => {
            const vectors = localVectors();
            const entry = batchOf(vectors);
            await plantProofQueueBatches(bridge, [entry]);

            const loaded = await harness.loadProofQueueBatch(bridge, 0n);
            expect(loaded.root).to.equal(entry.root);
            expect(loaded.inputQueueCursor).to.equal(entry.inputQueueCursor);
            expect(loaded.outputQueueCursor).to.equal(entry.outputQueueCursor);
            expect(loaded.outputBlockNumber).to.equal(entry.outputBlockNumber);

            await expect(
                harness.loadProofQueueBatch(bridge, 1n)
            ).to.be.revertedWithCustomError(
                bridge,
                'ProofQueueBatchNotCommitted'
            );
        });

        it('reads the proof queue the trusted bridge proves', async () => {
            expect(await harness.loadNoriProofQueue(bridge)).to.equal(
                ethers.getAddress(localVectors().proofQueue)
            );
        });
    });
});
