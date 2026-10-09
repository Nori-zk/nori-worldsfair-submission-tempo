/// <reference types="@nomicfoundation/hardhat-ethers" />
/// <reference types="@nomicfoundation/hardhat-ethers-chai-matchers" />
// NoriReadExample on the local Tempo node: every mainnet query in the mainnet
// fork vectors, verified on chain. The batch is planted in the Nori bridge's
// storage with `anvil_setStorageAt`, as `update` would write it.
import { expect } from 'chai';
import { type NoriTempoTokenBridge } from '@nori-zk/tempo-token-bridge';
import {
    NoriReadExample__factory,
    type NoriReadExample,
} from '../types/ethers-contracts/index.js';
import {
    batchOf,
    deployNoriBridge,
    ethers,
    mainnetVectors,
    plantProofQueueBatches,
    resultOf,
    resultsOf,
} from './helpers.js';

/** The committed batch holding the mainnet snapshots. */
const PROOF_QUEUE_BATCH_INDEX = 0n;

describe('NoriReadExample', () => {
    const vectors = mainnetVectors();
    let bridge: NoriTempoTokenBridge;
    let example: NoriReadExample;

    before(async () => {
        bridge = await deployNoriBridge(vectors.proofQueue);
        await plantProofQueueBatches(bridge, [batchOf(vectors)]);
        const [deployer] = await ethers.getSigners();
        example = await new NoriReadExample__factory(deployer).deploy(bridge);
        await example.waitForDeployment();
    });

    it('reads every mainnet query on chain', async () => {
        const results = resultsOf(vectors);
        expect(results).to.not.have.lengthOf(0);
        let maxGas = 0n;
        for (const vector of results) {
            const read = example.readSnapshotResult(
                vectors.noriSnapshot,
                vector.queryId,
                PROOF_QUEUE_BATCH_INDEX,
                vector.witness
            );
            const receipt = await (await read).wait();
            if (receipt && receipt.gasUsed > maxGas) maxGas = receipt.gasUsed;
            await expect(read)
                .to.emit(example, 'SnapshotResultRead')
                .withArgs(
                    vector.queryId,
                    vector.result.result,
                    vector.snapshot.snapshotIndex,
                    vector.snapshot.requestId,
                    vector.snapshot.blockNumber,
                    vector.snapshot.timestamp,
                    vectors.batch.outputBlockNumber
                );
        }
        console.log(
            `      readSnapshotResult: at most ${maxGas} gas over ${results.length} queries`
        );
    });

    it('rejects forged results and batches the bridge has not committed', async () => {
        const vector = resultOf(vectors, 'usds-lockbox');

        const forged = { ...vector.witness, result: '0x' + 'ff'.repeat(32) };
        await expect(
            example.readSnapshotResult(
                vectors.noriSnapshot,
                vector.queryId,
                PROOF_QUEUE_BATCH_INDEX,
                forged
            )
        ).to.be.revertedWithCustomError(example, 'ResultRootMismatch');

        await expect(
            example.readSnapshotResult(
                vectors.noriSnapshot,
                vector.queryId,
                PROOF_QUEUE_BATCH_INDEX + 1n,
                vector.witness
            )
        ).to.be.revertedWithCustomError(bridge, 'ProofQueueBatchNotCommitted');
    });
});
