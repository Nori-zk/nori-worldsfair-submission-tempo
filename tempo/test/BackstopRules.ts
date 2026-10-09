/// <reference types="@nomicfoundation/hardhat-ethers" />
/// <reference types="@nomicfoundation/hardhat-ethers-chai-matchers" />
// The guard rules, through BackstopRulesHarness: times are given, not read
// from the block, so each case sets its own clock.
import { expect } from 'chai';
import { KELP_REPLAY_START } from '@nori-zk/ethereum-snapshot';
import { MAX_U64, TIP20_DECIMALS } from '@nori-zk/tempo-token-bridge';
import { CHECKPOINTS, GuardStatus } from '../contracts/BackstopRules.const.js';
import {
    BackstopRulesHarness__factory,
    type BackstopRulesHarness,
} from '../types/ethers-contracts/index.js';
import { ethers, GUARD_TIMING, GUARD_TOLERANCE, tokens } from './helpers.js';

/** The rules' clock: the Kelp replay's start, whose snapshots land at +60 s and +600 s. */
const T0 = KELP_REPLAY_START;
const {
    checkpointIntervalSecs: CHECKPOINT_INTERVAL_SECS,
    maxStalenessSecs: MAX_STALENESS_SECS,
} = GUARD_TIMING;

async function guard(): Promise<BackstopRulesHarness> {
    const [deployer] = await ethers.getSigners();
    const harness = await new BackstopRulesHarness__factory(deployer).deploy({
        noriBridge: ethers.ZeroAddress,
        noriSnapshot: ethers.ZeroAddress,
        backingQuery: '0x' + '01'.repeat(32),
        pauseQuery: '0x' + '02'.repeat(32),
        backingDecimals: 18,
        tolerance: GUARD_TOLERANCE,
        ...GUARD_TIMING,
    });
    await harness.waitForDeployment();
    return harness;
}

/** A checkpoint every interval over `[from, to)`, each with `supply(time)`. */
async function checkpoints(
    g: BackstopRulesHarness,
    from: number,
    to: number,
    supply: (time: number) => bigint
) {
    const supplies: bigint[] = [];
    for (let time = from; time < to; time += CHECKPOINT_INTERVAL_SECS)
        supplies.push(supply(time));
    await (
        await g.pushCheckpoints(from, to, CHECKPOINT_INTERVAL_SECS, supplies)
    ).wait();
}

/** The deficit `applyBacking` returns, and applies it. */
async function applyBacking(
    g: BackstopRulesHarness,
    backing: bigint,
    ethBlock: number,
    ethTime: number
) {
    const deficit = await g.applyBacking.staticCall(backing, ethBlock, ethTime);
    await (await g.applyBacking(backing, ethBlock, ethTime)).wait();
    return deficit;
}

describe('Backstop rules', () => {
    it('scales backing to token units', async () => {
        const g = await guard();
        expect(await g.toTokenUnits(10n ** 18n, 18, TIP20_DECIMALS)).to.equal(
            tokens('1')
        );
        expect(await g.toTokenUnits(123n, 8, 8)).to.equal(123n);
        expect(await g.toTokenUnits(5n, 6, 9)).to.equal(5_000n);
        expect(await g.toTokenUnits(ethers.MaxUint256, 18, 9)).to.equal(
            MAX_U64
        );
    });

    it('the Kelp drain trips, and a refill stays tripped', async () => {
        const g = await guard();
        await checkpoints(g, T0 - 1_800, T0 + 1_800, () => tokens('116700'));

        expect(await applyBacking(g, tokens('116723.52'), 1, T0 + 60)).to.equal(
            0n
        );
        expect(await g.status(tokens('116700'), T0 + 600)).to.equal(
            GuardStatus.Healthy
        );

        const deficit = await applyBacking(g, tokens('223.52'), 2, T0 + 600);
        expect(deficit).to.equal(
            tokens('116700') - tokens('223.52') - GUARD_TOLERANCE
        );
        expect(await g.status(tokens('116700'), T0 + 700)).to.equal(
            GuardStatus.Tripped
        );

        await applyBacking(g, tokens('200000'), 3, T0 + 1_200);
        expect(await g.status(tokens('116700'), T0 + 1_300)).to.equal(
            GuardStatus.Tripped
        );
        expect((await g.guard()).tripEthBlock).to.equal(2n);
    });

    it('an inbound transfer in flight warns but never trips', async () => {
        // Lock on Ethereum at T0 + 100 (after the proven block), mint on Tempo at T0 + 160
        const g = await guard();
        await checkpoints(g, T0 - 600, T0 + 600, (t) =>
            t >= T0 + 160 ? tokens('1100') : tokens('1000')
        );

        expect(await applyBacking(g, tokens('1000'), 1, T0 + 60)).to.equal(0n);
        expect(await g.status(tokens('1100'), T0 + 600)).to.equal(
            GuardStatus.Warn
        );
    });

    it('a burn then unlock does not trip', async () => {
        // Burn on Tempo at T0, unlock on Ethereum at T0 + 300, proven at T0 + 400
        const g = await guard();
        await checkpoints(g, T0 - 600, T0 + 600, (t) =>
            t >= T0 ? tokens('900') : tokens('1000')
        );

        expect(await applyBacking(g, tokens('900'), 1, T0 + 400)).to.equal(0n);
        expect(await g.status(tokens('900'), T0 + 500)).to.equal(
            GuardStatus.Healthy
        );
    });

    it('a fast burn then unlock does not trip', async () => {
        // Burn on Tempo at T0 + 10, unlock on Ethereum at T0 + 30, snapshot at
        // T0 + 40; the first checkpoint after the burn is at T0 + 60
        const g = await guard();
        await checkpoints(g, T0 - 600, T0 + 1_200, (t) =>
            t > T0 ? tokens('900') : tokens('1000')
        );

        expect(await applyBacking(g, tokens('900'), 1, T0 + 40)).to.equal(0n);
        expect(await g.status(tokens('900'), T0 + 1_200)).to.equal(
            GuardStatus.Healthy
        );
    });

    it('a forged Tempo mint warns, then trips', async () => {
        // 120k forged at T0, backing unchanged at 1,000
        const g = await guard();
        await checkpoints(g, T0 - 600, T0 + 1_200, (t) =>
            t >= T0 ? tokens('121000') : tokens('1000')
        );

        expect(await applyBacking(g, tokens('1000'), 1, T0 + 60)).to.equal(0n);
        expect(await g.status(tokens('121000'), T0 + 120)).to.equal(
            GuardStatus.Warn
        );
        // Once the whole window is after the forgery
        expect(
            await applyBacking(g, tokens('1000'), 2, T0 + 660)
        ).to.be.greaterThan(0n);
        expect(await g.status(tokens('121000'), T0 + 700)).to.equal(
            GuardStatus.Tripped
        );
    });

    it('no checkpoint in the window gives no verdict', async () => {
        const g = await guard();
        await (await g.pushCheckpoint(T0 - 5_000, tokens('1000000'))).wait();
        // Only after the backing's time, e.g. a guard created after the snapshot
        await (await g.pushCheckpoint(T0 + 100, tokens('1000000'))).wait();

        expect(await applyBacking(g, 0n, 1, T0)).to.equal(0n);
        const state = await g.guard();
        expect(state.tripped).to.equal(false);
        expect(state.backingEthBlock).to.equal(1n);
    });

    it('paused and stale states', async () => {
        const g = await guard();
        expect(await g.status(0n, T0)).to.equal(
            GuardStatus.Stale,
            'nothing proven yet'
        );

        await applyBacking(g, tokens('10'), 1, T0);
        expect(await g.status(0n, T0 + MAX_STALENESS_SECS)).to.equal(
            GuardStatus.Healthy
        );
        expect(await g.status(0n, T0 + MAX_STALENESS_SECS + 1)).to.equal(
            GuardStatus.Stale
        );

        await (await g.setPaused(true)).wait();
        expect(await g.status(0n, T0)).to.equal(GuardStatus.PausedAtSource);
        await (await g.setTripped(true)).wait();
        expect(await g.status(0n, T0)).to.equal(GuardStatus.Tripped);
    });

    it('checkpoints keep the latest hour', async () => {
        const g = await guard();
        /** The time of the `n`th checkpoint interval from T0. */
        const at = (n: number) => T0 + n * CHECKPOINT_INTERVAL_SECS;
        const pushed = 100;
        expect(await g.checkpointDue(T0)).to.equal(true);
        await checkpoints(g, T0, at(pushed / 2), (t) => BigInt(t - T0));
        await checkpoints(g, at(pushed / 2), at(pushed), (t) => BigInt(t - T0));

        expect(
            await g.checkpointDue(at(pushed - 1) + CHECKPOINT_INTERVAL_SECS / 2)
        ).to.equal(false);
        expect(await g.checkpointDue(at(pushed))).to.equal(true);
        // Only the last CHECKPOINTS remain
        const times = (await g.guard()).checkpoints.map(
            (checkpoint) => checkpoint.time
        );
        expect(times.reduce((a, b) => (a < b ? a : b))).to.equal(
            BigInt(at(pushed - CHECKPOINTS))
        );
    });
});
