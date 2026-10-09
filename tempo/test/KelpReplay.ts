/// <reference types="@nomicfoundation/hardhat-ethers" />
/// <reference types="@nomicfoundation/hardhat-ethers-chai-matchers" />
// The Kelp drain replayed on the local Tempo node. A guard over a TIP-20
// (116,700 supply) reads the replay vectors' lockbox balance and pause flag
// while the clock moves through their 2030 timeline: healthy, drained
// (trips), refilled (stays tripped), paused at source. Each case starts from
// an `evm_snapshot` and reverts to it, since the clock only moves forward.
import { expect } from 'chai';
import { KELP_REPLAY_START } from '@nori-zk/ethereum-snapshot';
import { type NoriTempoTokenBridge } from '@nori-zk/tempo-token-bridge';
import { ReadKind } from '../contracts/Backstop.const.js';
import { GuardStatus } from '../contracts/BackstopRules.const.js';
import { Backstop__factory } from '../types/ethers-contracts/index.js';
import {
    batchOf,
    createToken,
    deployNoriBridge,
    ethers,
    GUARD_TIMING,
    GUARD_TOLERANCE,
    kelpReplayVectors,
    plantProofQueueBatches,
    resultOf,
    revertTo,
    setNextBlockTime,
    snapshotState,
    timeTravel,
    tokens,
    type VectorResult,
} from './helpers.js';

const T0 = KELP_REPLAY_START;
const SUPPLY = tokens('116700');
const BACKING_QUERY = 'lockbox-balance';
const PAUSE_QUERY = 'lockbox-paused';
/** The committed batch holding the replay's snapshots. */
const PROOF_QUEUE_BATCH_INDEX = 0n;

describe('Kelp replay', () => {
    const vectors = kelpReplayVectors();
    let bridge: NoriTempoTokenBridge;
    let stateBeforeCase: string;

    before(async () => {
        bridge = await deployNoriBridge(vectors.proofQueue);
        await plantProofQueueBatches(bridge, [batchOf(vectors)]);
    });

    beforeEach(async () => {
        stateBeforeCase = await snapshotState();
    });

    afterEach(async () => {
        await revertTo(stateBeforeCase);
    });

    /**
     * A Backstop with a guard over a new TIP-20 holding `SUPPLY`, created by
     * the first dev account at T0 - 600, reading `pauseQuery` (by default the
     * lockbox's pause flag).
     */
    async function setup(pauseQuery = resultOf(vectors, PAUSE_QUERY).queryId) {
        const [admin] = await ethers.getSigners();
        const backstop = await new Backstop__factory(admin).deploy();
        await backstop.waitForDeployment();
        const token = await createToken('rsETH', SUPPLY);

        await setNextBlockTime(T0 - 600);
        await (
            await backstop.createGuard(token, {
                noriBridge: await bridge.getAddress(),
                noriSnapshot: vectors.noriSnapshot,
                backingQuery: resultOf(vectors, BACKING_QUERY).queryId,
                pauseQuery,
                backingDecimals: 18,
                tolerance: GUARD_TOLERANCE,
                ...GUARD_TIMING,
            })
        ).wait();
        const guardId = await backstop.guardIdOf(token, admin.address);

        const submitWitness = (
            kind: ReadKind,
            witness: VectorResult['witness']
        ) =>
            backstop.submitRead(
                guardId,
                kind,
                PROOF_QUEUE_BATCH_INDEX,
                witness
            );
        /** Submits snapshot `snapshotIndex`'s lockbox balance or pause flag. */
        const submit = async (snapshotIndex: number, kind: ReadKind) => {
            const query =
                kind === ReadKind.Backing ? BACKING_QUERY : PAUSE_QUERY;
            return (
                await submitWitness(
                    kind,
                    resultOf(vectors, query, snapshotIndex).witness
                )
            ).wait();
        };
        return { admin, backstop, guardId, submit, submitWitness };
    }

    it('the drain trips the guard, and a refill does not reset it', async () => {
        const { admin, backstop, guardId, submit, submitWitness } =
            await setup();

        // Supply checkpoints inside each snapshot's window
        for (const at of [T0 - 300, T0 + 300, T0 + 1_500]) {
            await setNextBlockTime(at);
            await (await backstop.checkpoint(guardId)).wait();
        }
        // 10 minutes after the last snapshot, the proofs have landed
        await timeTravel(T0 + 3_600);

        // Snapshot 1: 116,723.52 rsETH backs 116,700
        const backingRead = await submit(1, ReadKind.Backing);
        const pauseRead = await submit(1, ReadKind.Pause);
        console.log(
            `      submitRead: ${backingRead?.gasUsed} gas (backing), ${pauseRead?.gasUsed} (pause)`
        );
        expect(await backstop.status(guardId)).to.equal(GuardStatus.Healthy);
        console.log(
            `      assertHealthy: ${await backstop.assertHealthy.estimateGas(guardId)} gas`
        );

        // Snapshot 2: drained to 223.52, trips
        const drained = await submit(2, ReadKind.Backing);
        const read = drained?.logs
            .map((log) => backstop.interface.parseLog(log))
            .find((event) => event?.name === 'BackingRead');
        expect(read?.args.tripped).to.equal(true);
        expect(read?.args.deficit).to.equal(
            SUPPLY - tokens('223.52') - GUARD_TOLERANCE
        );
        await expect(
            backstop.assertHealthy(guardId)
        ).to.be.revertedWithCustomError(backstop, 'Tripped');

        // An old or forged read is refused
        const drainEthBlock = BigInt(
            resultOf(vectors, BACKING_QUERY, 2).snapshot.blockNumber
        );
        const oldRead = resultOf(vectors, BACKING_QUERY, 1);
        await expect(submitWitness(ReadKind.Backing, oldRead.witness))
            .to.be.revertedWithCustomError(backstop, 'ReadNotNewer')
            .withArgs(oldRead.snapshot.blockNumber, drainEthBlock);
        const forged = {
            ...resultOf(vectors, BACKING_QUERY, 3).witness,
            result: '0x' + '0f'.repeat(32),
        };
        await expect(
            submitWitness(ReadKind.Backing, forged)
        ).to.be.revertedWithCustomError(backstop, 'ResultRootMismatch');

        // Snapshot 3: refilled to 40,300, still tripped
        const refillRead = await submit(3, ReadKind.Backing);
        console.log(
            `      submitRead: ${refillRead?.gasUsed} gas (a later backing read)`
        );
        const refilled = await backstop.guard(guardId);
        expect(refilled.tripped).to.equal(true);
        expect(refilled.tripEthBlock).to.equal(drainEthBlock);
        expect(refilled.backing).to.equal(tokens('40300'));

        // Snapshot 4: paused on Ethereum
        await submit(4, ReadKind.Pause);

        // Only the admin unlatches; the source pause remains
        const [, stranger] = await ethers.getSigners();
        await expect(backstop.connect(stranger).unlatch(guardId))
            .to.be.revertedWithCustomError(backstop, 'NotAdmin')
            .withArgs(stranger.address, admin.address);
        await (await backstop.unlatch(guardId)).wait();
        expect(await backstop.status(guardId)).to.equal(
            GuardStatus.PausedAtSource
        );
        await expect(
            backstop.assertHealthy(guardId)
        ).to.be.revertedWithCustomError(backstop, 'PausedAtSource');
    });

    it('rejects a pause query that is not a bool', async () => {
        // Misconfigured: the pause query is the lockbox's balance getter
        const { backstop, guardId, submitWitness } = await setup(
            resultOf(vectors, BACKING_QUERY).queryId
        );

        await expect(
            submitWitness(
                ReadKind.Pause,
                resultOf(vectors, BACKING_QUERY, 1).witness
            )
        ).to.be.revertedWithCustomError(backstop, 'PauseResultNotBool');
        expect((await backstop.guard(guardId)).paused).to.equal(false);
    });
});
