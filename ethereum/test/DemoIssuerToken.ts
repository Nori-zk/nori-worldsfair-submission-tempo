/// <reference types="@nomicfoundation/hardhat-ethers" />
/// <reference types="@nomicfoundation/hardhat-ethers-chai-matchers" />
// The Ethereum half of a migration to Tempo, on nori-tempo-sdk's real
// NoriTokenBridge and proof queue: an issuer's 18-decimal ERC-20 locked as
// 6-decimal bridge units (a TIP-20's), and its pause synced for proving.
import { expect } from 'chai';
import hre from 'hardhat';
import {
    LOCKED_ERC20_SLOT_INDEX,
    NoriProofRequestQueue__factory,
    NoriTokenBridge__factory,
    PAUSE_KEY,
    PAUSE_STATE_PAUSED,
    PAUSE_STATE_SLOT_INDEX,
    PAUSE_STATE_UNPAUSED,
} from '@nori-zk/ethereum-tempo-bridge';
import { DemoIssuerToken__factory } from '../types/ethers-contracts/index.js';
const { ethers } = await hre.network.getOrCreate();

const abi = ethers.AbiCoder.defaultAbiCoder();

describe('DemoIssuerToken', () => {
    /** The issuer's token with a supply at `holder`, and a token bridge on a fresh queue. */
    async function deployMigration() {
        const [issuer, holder, tempoRecipient] = await ethers.getSigners();
        const token = await new DemoIssuerToken__factory(issuer).deploy(
            'Demo USD',
            'DUSD',
            issuer.address
        );
        await (
            await token.mint(holder.address, ethers.parseEther('1000000'))
        ).wait();
        const queue = await new NoriProofRequestQueue__factory(issuer).deploy(
            issuer.address,
            issuer.address,
            0n
        );
        const bridge = await new NoriTokenBridge__factory(issuer).deploy(
            issuer.address,
            await queue.getAddress(),
            ethers.ZeroAddress
        );
        // The Tempo recipient's commitment: sha256 of its 20-byte address
        const codeChallenge = BigInt(ethers.sha256(tempoRecipient.address));
        return {
            issuer,
            holder,
            tempoRecipient,
            token,
            queue,
            bridge,
            codeChallenge,
        };
    }

    it('Should give the issuer the admin, minter and pauser roles, and only the issuer', async function () {
        const { issuer, holder, token } = await deployMigration();
        for (const role of [
            await token.DEFAULT_ADMIN_ROLE(),
            await token.MINTER_ROLE(),
            await token.PAUSER_ROLE(),
        ]) {
            expect(await token.hasRole(role, issuer.address)).to.equal(true);
            expect(await token.hasRole(role, holder.address)).to.equal(false);
        }
        expect(await token.decimals()).to.equal(18n);
        await expect(
            token.connect(holder).pause()
        ).to.be.revertedWithCustomError(
            token,
            'AccessControlUnauthorizedAccount'
        );
    });

    it('Should lock 18 decimals as 6-decimal bridge units, and refuse dust below one', async function () {
        const { holder, token, bridge, codeChallenge } =
            await deployMigration();
        const bridgeAddress = await bridge.getAddress();
        const amount = ethers.parseEther('1000.5');
        await (
            await token.connect(holder).approve(bridgeAddress, amount)
        ).wait();

        await expect(
            bridge
                .connect(holder)
                .lockERC20(await token.getAddress(), amount + 1n, codeChallenge)
        ).to.be.revertedWithCustomError(bridge, 'InvalidTokenUnitMultiple');

        await expect(
            bridge
                .connect(holder)
                .lockERC20(await token.getAddress(), amount, codeChallenge)
        )
            .to.emit(bridge, 'ERC20Locked')
            .withArgs(
                holder.address,
                await token.getAddress(),
                codeChallenge,
                amount,
                0n
            );
        // 1000.5 tokens = 1,000,500,000 TIP-20 base units
        expect(
            await bridge.lockedERC20(await token.getAddress(), codeChallenge)
        ).to.equal(1_000_500_000n);
        expect(
            await bridge.totalLockedERC20BU(await token.getAddress())
        ).to.equal(1_000_500_000n);
        // Retired on Ethereum: the bridge holds it and has no unlock path
        expect(await token.balanceOf(bridgeAddress)).to.equal(amount);
        await expect(bridge.unlockTokens()).to.be.revertedWithCustomError(
            bridge,
            'UnlockNotSupported'
        );
    });

    it('Should enqueue the lock as the leaf the Tempo bridge mints against', async function () {
        const { holder, token, queue, bridge, codeChallenge } =
            await deployMigration();
        const tokenAddress = await token.getAddress();
        const amount = ethers.parseEther('25');
        await (
            await token
                .connect(holder)
                .approve(await bridge.getAddress(), amount)
        ).wait();
        await (
            await bridge
                .connect(holder)
                .lockERC20(tokenAddress, amount, codeChallenge)
        ).wait();

        const request = await queue.requests(0n);
        expect(request.target).to.equal(await bridge.getAddress());
        expect(request.collectionKeysCount).to.equal(2n);
        expect(request.collectionKeys[0]).to.equal(
            ethers.toBeHex(codeChallenge, 32)
        );
        expect(request.collectionKeys[1]).to.equal(
            ethers.zeroPadValue(tokenAddress, 32)
        );
        // The proven slot: lockedERC20[token][codeChallenge]
        expect(request.slotKey).to.equal(
            ethers.keccak256(
                abi.encode(
                    ['uint256', 'bytes32'],
                    [
                        codeChallenge,
                        ethers.keccak256(
                            abi.encode(
                                ['address', 'uint256'],
                                [tokenAddress, LOCKED_ERC20_SLOT_INDEX]
                            )
                        ),
                    ]
                )
            )
        );
        expect(
            BigInt(
                await ethers.provider.getStorage(
                    await bridge.getAddress(),
                    request.slotKey
                )
            )
        ).to.equal(25_000_000n);
    });

    it("Should block locks while paused, and sync the issuer's pause for proving", async function () {
        const { issuer, holder, token, queue, bridge, codeChallenge } =
            await deployMigration();
        const tokenAddress = await token.getAddress();
        const amount = ethers.parseEther('10');
        await (
            await token
                .connect(holder)
                .approve(await bridge.getAddress(), amount)
        ).wait();

        await (await token.connect(issuer).pause()).wait();
        await expect(
            bridge
                .connect(holder)
                .lockERC20(tokenAddress, amount, codeChallenge)
        ).to.be.revertedWithCustomError(token, 'EnforcedPause');

        // Anyone syncs; the proof reads pauseState[token] at its own block
        await expect(bridge.connect(holder).syncPause(tokenAddress))
            .to.emit(bridge, 'PauseSynced')
            .withArgs(tokenAddress, true);
        expect(await bridge.pauseState(tokenAddress)).to.equal(
            PAUSE_STATE_PAUSED
        );
        const request = await queue.requests(0n);
        expect(request.collectionKeys[0]).to.equal(PAUSE_KEY);
        expect(request.slotKey).to.equal(
            ethers.keccak256(
                abi.encode(
                    ['address', 'uint256'],
                    [tokenAddress, PAUSE_STATE_SLOT_INDEX]
                )
            )
        );

        await (await token.connect(issuer).unpause()).wait();
        await (await bridge.syncPause(tokenAddress)).wait();
        expect(await bridge.pauseState(tokenAddress)).to.equal(
            PAUSE_STATE_UNPAUSED
        );
    });
});
