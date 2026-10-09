/// <reference types="@nomicfoundation/hardhat-ethers" />
// Shared by the suites: the real Nori bridge on the local Tempo node
// (`anvil --network tempo`), committed batches planted in its storage as
// `update` writes them, and test-vectors/nori-snapshot as contract arguments.
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import hre from 'hardhat';
import {
    ISSUER_ROLE_NAME,
    ITIP20__factory,
    ITIP20Factory__factory,
    MAX_U64,
    NoriTempoTokenBridge__factory,
    PACKED_STATE_OFFSETS,
    PACKED_STATE_SLOT,
    PATH_USD_ADDRESS,
    PROOF_QUEUE_BATCH_OFFSETS,
    PROOF_QUEUE_BATCHES_SLOT,
    sp1VerifierJson,
    TIP20_DECIMALS,
    TIP20_FACTORY_ADDRESS,
    type NoriTempoTokenBridge,
} from '@nori-zk/tempo-token-bridge';

export const { ethers } = await hre.network.getOrCreate();

/** The program vkey the test bridge pins; no test sends it a proof. */
const TEST_VKEY = '0x' + '01'.repeat(32);

const word = (value: bigint) => ethers.toBeHex(value, 32);

// -----------------------------------------------------------------
// The vectors
// -----------------------------------------------------------------

export interface VectorBatch {
    root: string;
    inputQueueCursor: number;
    outputQueueCursor: number;
    outputBlockNumber: number;
}

export interface VectorRequest {
    requestId: number;
    index: number;
    target: string;
    collectionKeysCount: number;
    collectionKeys: [string, string];
    value: string;
    leaf: string;
    path: string[];
}

export interface VectorSnapshotResult {
    name: string;
    target: string;
    data: string;
    queryId: string;
    result: string;
    index: number;
    path: string[];
}

export interface VectorSnapshot {
    snapshotIndex: number;
    requestId: number;
    blockNumber: number;
    timestamp: number;
    results: VectorSnapshotResult[];
}

export interface Vectors {
    description: string;
    noriSnapshot: string;
    proofQueue: string;
    batch: VectorBatch;
    requests: VectorRequest[];
    snapshots: VectorSnapshot[];
}

const readVectors = (name: string): Vectors =>
    JSON.parse(
        readFileSync(
            new URL(
                `../../test-vectors/nori-snapshot/${name}`,
                import.meta.url
            ),
            'utf8'
        )
    ) as Vectors;

/** Reproducible vectors: batch `[1, 5)` on a local network, holding a request that is not a snapshot and three snapshots. */
export const localVectors = () => readVectors('snapshot-read-vectors.json');
/** One snapshot of every mainnet query, taken on a mainnet fork. */
export const mainnetVectors = () =>
    readVectors('snapshot-read-mainnet-vectors.json');
/** The Kelp drain replayed: four snapshots of a lockbox's balance and pause flag, at fixed times from 2030-01-01. */
export const kelpReplayVectors = () => readVectors('kelp-replay-vectors.json');

/** The batch as `update` commits it. */
export const batchOf = (vectors: Vectors) => ({
    root: vectors.batch.root,
    outputBlockNumber: BigInt(vectors.batch.outputBlockNumber),
    inputQueueCursor: BigInt(vectors.batch.inputQueueCursor),
    outputQueueCursor: BigInt(vectors.batch.outputQueueCursor),
    tempoBlockNumber: 0n,
});

export const requestOf = (vectors: Vectors, requestId: number) => {
    const request = vectors.requests.find((r) => r.requestId === requestId);
    if (!request) throw new Error(`No request ${requestId} in the vectors`);
    return request;
};

/** A request's witness in its batch, as the bridge's `VerifiedRequestWitness`. */
export const requestWitnessOf = (vectors: Vectors, requestId: number) => {
    const request = requestOf(vectors, requestId);
    return {
        path: [...request.path],
        index: BigInt(request.index),
        value: {
            target: request.target,
            collectionKeysCount: request.collectionKeysCount,
            collectionKeys: [...request.collectionKeys] as [string, string],
            value: BigInt(request.value),
        },
    };
};

/** One snapshot result with what a consumer passes to `verifySnapshotResult`. */
export interface VectorResult {
    snapshot: VectorSnapshot;
    result: VectorSnapshotResult;
    queryId: string;
    witness: {
        request: ReturnType<typeof requestWitnessOf>;
        result: string;
        resultIndex: number;
        resultPath: string[];
    };
}

/** Every snapshot result in the batch, in order. */
export const resultsOf = (vectors: Vectors): VectorResult[] =>
    vectors.snapshots.flatMap((snapshot) =>
        snapshot.results.map((result) => ({
            snapshot,
            result,
            queryId: result.queryId,
            witness: {
                request: requestWitnessOf(vectors, snapshot.requestId),
                result: result.result,
                resultIndex: result.index,
                resultPath: [...result.path],
            },
        }))
    );

/** The result of the query called `name`, in the snapshot with `snapshotIndex` when given. */
export const resultOf = (
    vectors: Vectors,
    name: string,
    snapshotIndex?: number
): VectorResult => {
    const found = resultsOf(vectors).find(
        (vector) =>
            vector.result.name === name &&
            (snapshotIndex === undefined ||
                vector.snapshot.snapshotIndex === snapshotIndex)
    );
    if (!found) throw new Error(`No query ${name} in the vectors`);
    return found;
};

// -----------------------------------------------------------------
// The Nori bridge
// -----------------------------------------------------------------

/**
 * Deploys the Nori bridge as the sdk deploys it: the SP1 v6.1.0 Groth16
 * verifier, nETH through TIP20Factory, and the bridge proving `proofQueue`.
 */
export async function deployNoriBridge(
    proofQueue: string
): Promise<NoriTempoTokenBridge> {
    const [deployer] = await ethers.getSigners();
    const verifier = await new ethers.ContractFactory(
        sp1VerifierJson.abi,
        sp1VerifierJson.bytecode,
        deployer
    ).deploy();
    await verifier.waitForDeployment();
    const token = await createToken('nETH', 0n);
    const bridge = await new NoriTempoTokenBridge__factory(deployer).deploy(
        await verifier.getAddress(),
        TEST_VKEY,
        token,
        ethers.ZeroHash,
        deployer.address,
        proofQueue
    );
    await bridge.waitForDeployment();
    return bridge;
}

/**
 * A TIP-20 created through TIP20Factory with the first dev account as admin
 * and issuer, holding `supply` (6 decimals) minted to it.
 */
export async function createToken(
    symbol: string,
    supply: bigint
): Promise<string> {
    const [deployer] = await ethers.getSigners();
    const factory = ITIP20Factory__factory.connect(
        TIP20_FACTORY_ADDRESS,
        deployer
    );
    const args = [
        symbol,
        symbol,
        'ETH',
        PATH_USD_ADDRESS,
        deployer.address,
        ethers.hexlify(randomBytes(32)),
    ] as const;
    const address = await factory.createToken.staticCall(...args);
    await (await factory.createToken(...args)).wait();
    if (supply > 0n) {
        const token = ITIP20__factory.connect(address, deployer);
        await (
            await token.grantRole(ethers.id(ISSUER_ROLE_NAME), deployer.address)
        ).wait();
        await (await token.mint(deployer.address, supply)).wait();
    }
    return address;
}

/**
 * Plants committed proof queue batches in the bridge's storage with
 * `anvil_setStorageAt`, as `update` writes them: each entry at
 * `keccak256(index, 3)`, and the count in slot 2.
 */
export async function plantProofQueueBatches(
    bridge: NoriTempoTokenBridge,
    batches: Array<ReturnType<typeof batchOf>>
) {
    const address = await bridge.getAddress();
    const provider = ethers.provider;
    for (const [i, batch] of batches.entries()) {
        const base = BigInt(
            ethers.keccak256(
                ethers.AbiCoder.defaultAbiCoder().encode(
                    ['uint64', 'uint256'],
                    [i, PROOF_QUEUE_BATCHES_SLOT]
                )
            )
        );
        const packed =
            (batch.outputBlockNumber <<
                PROOF_QUEUE_BATCH_OFFSETS.outputBlockNumber) |
            (batch.inputQueueCursor <<
                PROOF_QUEUE_BATCH_OFFSETS.inputQueueCursor) |
            (batch.outputQueueCursor <<
                PROOF_QUEUE_BATCH_OFFSETS.outputQueueCursor) |
            (batch.tempoBlockNumber <<
                PROOF_QUEUE_BATCH_OFFSETS.tempoBlockNumber);
        await provider.send('anvil_setStorageAt', [
            address,
            word(base),
            batch.root,
        ]);
        await provider.send('anvil_setStorageAt', [
            address,
            word(base + 1n),
            word(packed),
        ]);
    }
    const state = BigInt(await provider.getStorage(address, PACKED_STATE_SLOT));
    const countOffset = PACKED_STATE_OFFSETS.proofQueueBatchCount;
    const withCount =
        (state & ~(MAX_U64 << countOffset)) |
        (BigInt(batches.length) << countOffset);
    await provider.send('anvil_setStorageAt', [
        address,
        word(PACKED_STATE_SLOT),
        word(withCount),
    ]);
}

// -----------------------------------------------------------------
// The guards
// -----------------------------------------------------------------

/** An amount of a TIP-20, in its units. */
export const tokens = (amount: string) =>
    ethers.parseUnits(amount, TIP20_DECIMALS);

/** The suites' guard tolerance: one token. */
export const GUARD_TOLERANCE = tokens('1');

/** The suites' guard timing: a 10-minute window with a minute of skew, a checkpoint a minute, stale after 2 hours. */
export const GUARD_TIMING = {
    windowSecs: 600,
    skewSecs: 60,
    checkpointIntervalSecs: 60,
    maxStalenessSecs: 7_200,
} as const;

// -----------------------------------------------------------------
// The clock
// -----------------------------------------------------------------

/** The next block's timestamp; the next transaction, or `mine()`, lands at it. */
export async function setNextBlockTime(unixTime: number) {
    await ethers.provider.send('evm_setNextBlockTimestamp', [unixTime]);
}

/** Moves the clock to `unixTime` with a block at it, for views that read the time. */
export async function timeTravel(unixTime: number) {
    await setNextBlockTime(unixTime);
    await ethers.provider.send('evm_mine', []);
}

/** The node's state now, to `revertTo` after a test that moved the clock. */
export const snapshotState = (): Promise<string> =>
    ethers.provider.send('evm_snapshot', []);

export async function revertTo(id: string) {
    await ethers.provider.send('evm_revert', [id]);
}
