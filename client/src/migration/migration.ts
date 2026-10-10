import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
    Contract,
    formatUnits,
    isError,
    parseUnits,
    sha256,
    Wallet,
    ZeroAddress,
    zeroPadValue,
    ZeroHash,
    type JsonRpcProvider,
} from 'ethers';
import { firstValueFrom } from 'rxjs';
import {
    NoriProofRequestQueue__factory,
    NoriTokenBridge__factory,
    PAUSE_STATE_PAUSED,
    PAUSE_STATE_UNPAUSED,
    type NoriTokenBridge,
} from '@nori-zk/ethereum-tempo-bridge';
import {
    applyPause,
    bothReady$,
    createConnections,
    getErc20TotalMinted,
    getProofRequestStateSnapshot,
    getVerifiedRequestWitness,
    mintERC20,
    ProofRequestState,
    type Connections,
} from '@nori-zk/nori-bridge-tempo-sdk';
import {
    ITIP20__factory,
    NoriTempoTokenBridge__factory,
    PAUSE_KEY,
    TIP20_DECIMALS,
    type NoriTempoTokenBridge,
} from '@nori-zk/tempo-token-bridge';
import {
    connectTempo,
    contractErrorName,
    createProvider,
    RPC_TIMEOUT_MS,
    type Tempo,
} from '../keeper/tempo.js';
import { errorMessage, withTimeout } from '../keeper/util.js';
import type { MigrationConfig, MigrationToken } from './config.js';

/** How long an Ethereum transaction (approve, lock, sync) is waited for. */
const ETHEREUM_WAIT_MS = 3 * 60_000;
/** The sdk's requests have no timeout of their own; a hung one would stall the loop. */
const PROOF_REQUEST_TIMEOUT_MS = 2 * 60_000;

// NoriTempoTokenBridge errors that mean "nothing left to do"
const PAUSE_NOT_NEWER = 'PauseNotNewer';
const ZERO_MINT_AMOUNT = 'ZeroMintAmount';
const MINTED_EXCEEDS_LOCKED = 'MintedExceedsLocked';

const ERC20_ABI = [
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function totalSupply() view returns (uint256)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function paused() view returns (bool)',
];

/** A `lockERC20` transaction whose deposit is not minted on Tempo yet. */
interface PendingLock {
    name: string;
    ethToken: string;
    lockTxHash: string;
    /** The Tempo address the deposit commits to: only it can claim. */
    recipient: string;
}

/** A `syncPause` transaction whose proof is not applied on Tempo yet. */
interface PendingPause {
    name: string;
    ethToken: string;
    syncPauseTxHash: string;
}

interface MigrationState {
    locksPending: PendingLock[];
    pausesPending: PendingPause[];
}

/** An amount of a TIP-20 (6 decimals), or of bridge units, for display. */
const tip20Amount = (amount: bigint) => formatUnits(amount, TIP20_DECIMALS);

/**
 * Migrates ERC-20s to their TIP-20 mirrors on Tempo through Nori: locks on
 * Ethereum (`NoriTokenBridge.lockERC20`), claims on Tempo once proven
 * (`mintERC20`), and keeps each mirror paused as its ERC-20 is (`syncPause`,
 * then `applyPause`). It signs through its own clients and reads proof
 * requests through the sdk's connections, as the keeper does.
 */
export class Migration {
    private constructor(
        private readonly config: MigrationConfig,
        private readonly tempo: Tempo,
        private readonly tempoBridge: NoriTempoTokenBridge,
        private readonly provider: JsonRpcProvider,
        private readonly connections: Connections
    ) {}

    static async connect(config: MigrationConfig): Promise<Migration> {
        const key = process.env.TEMPO_PRIVATE_KEY;
        if (!key) throw new Error('Missing env: TEMPO_PRIVATE_KEY');
        const tempo = connectTempo(config.tempo.rpcUrl, key);
        const provider = createProvider(config.ethereum.rpcUrl);
        const [{ chainId }, { chainId: tempoChainId }] = await Promise.all([
            provider.getNetwork(),
            tempo.provider.getNetwork(),
        ]);
        const connections = createConnections({
            network: config.network,
            ethereum: {
                expectedChainId: chainId,
                http: { rpcUrl: config.ethereum.rpcUrl },
            },
            tempo: {
                expectedChainId: tempoChainId,
                http: { rpcUrl: config.tempo.rpcUrl },
            },
        });
        await withTimeout(
            firstValueFrom(bothReady$(connections)),
            RPC_TIMEOUT_MS,
            'Ethereum and Tempo connections'
        );
        const tempoBridge = NoriTempoTokenBridge__factory.connect(
            config.tempo.bridge,
            tempo.signer
        );
        return new Migration(config, tempo, tempoBridge, provider, connections);
    }

    private log(message: string) {
        console.log(`${new Date().toISOString()} ${message}`);
    }

    /** The Ethereum signer of locks and pause syncs. */
    private ethereumSigner(): Wallet {
        const key = process.env.ETH_PRIVATE_KEY;
        if (!key) throw new Error('Missing env: ETH_PRIVATE_KEY');
        return new Wallet(key, this.provider);
    }

    private tokenBridge(): NoriTokenBridge {
        return NoriTokenBridge__factory.connect(
            this.config.ethereum.tokenBridge,
            this.ethereumSigner()
        );
    }

    private token(name: string): MigrationToken {
        const token = this.config.tokens.find((entry) => entry.name === name);
        if (!token)
            throw new Error(
                `No token "${name}" in the config (${this.config.tokens.map((entry) => entry.name).join(', ')})`
            );
        return token;
    }

    private loadState(): MigrationState {
        return {
            locksPending: [],
            pausesPending: [],
            ...(existsSync(this.config.stateFile)
                ? (JSON.parse(
                      readFileSync(this.config.stateFile, 'utf8')
                  ) as Partial<MigrationState>)
                : {}),
        };
    }

    private saveState(state: MigrationState) {
        writeFileSync(
            this.config.stateFile,
            JSON.stringify(state, null, 2) + '\n'
        );
    }

    /**
     * Locks `amount` of a configured ERC-20 (in its own units, e.g.
     * "1000.5") for a Tempo recipient (the Tempo key's address by default),
     * approving the bridge first when needed and paying the queue fee in
     * ETH. The amount must be a whole number of TIP-20 units: an 18-decimal
     * token locks in steps of 10^12 of its base units.
     */
    async lock(name: string, amount: string, recipient?: string) {
        const token = this.token(name);
        const to = recipient ?? this.tempo.signer.address;
        const bridge = this.tokenBridge();
        const signer = this.ethereumSigner();
        const erc20 = new Contract(token.ethToken, ERC20_ABI, signer);
        const [decimals, symbol] = await Promise.all([
            erc20.decimals() as Promise<bigint>,
            erc20.symbol() as Promise<string>,
        ]);
        const units = parseUnits(amount, decimals);
        const [queueFeeWei, fee, net] = await bridge.previewLockERC20(
            token.ethToken,
            units
        );
        const bridgeAddress = await bridge.getAddress();
        const allowance = (await erc20.allowance(
            signer.address,
            bridgeAddress
        )) as bigint;
        if (allowance < units) {
            const approval = await erc20.approve(bridgeAddress, units);
            await approval.wait(1, ETHEREUM_WAIT_MS);
        }
        const codeChallenge = BigInt(sha256(to));
        const tx = await bridge.lockERC20(
            token.ethToken,
            units,
            codeChallenge,
            {
                value: queueFeeWei,
            }
        );
        // Pending as soon as it is sent: a slow block can't lose it
        const state = this.loadState();
        state.locksPending.push({
            name: token.name,
            ethToken: token.ethToken,
            lockTxHash: tx.hash,
            recipient: to,
        });
        this.saveState(state);
        const receipt = await tx.wait(1, ETHEREUM_WAIT_MS);
        this.log(
            `${token.name}: locked ${formatUnits(net, decimals)} ${symbol} for Tempo ${to}` +
                ` (fee ${formatUnits(fee, decimals)} ${symbol}, queue fee ${formatUnits(queueFeeWei, 18)} ETH)` +
                ` | lockERC20 ${tx.hash}, block ${receipt?.blockNumber}`
        );
    }

    /**
     * Mints each pending lock whose batch Nori has proven to its recipient
     * on Tempo (`mintERC20`), when the Tempo key is that recipient. Minting
     * is delta-based, so a lock a later claim already covered is done.
     */
    async claim(quiet = false) {
        const pending = this.loadState().locksPending;
        const stillPending: PendingLock[] = [];
        for (const lock of pending) {
            let done = false;
            try {
                done = await this.claimLock(lock);
            } catch (error) {
                this.log(
                    `${lock.name}: claim of ${lock.lockTxHash} failed: ${errorMessage(error)}`
                );
            }
            if (!done) stillPending.push(lock);
        }
        // Keep what another process (a CLI `lock`) added meanwhile
        const current = this.loadState();
        const added = current.locksPending.filter(
            (lock) =>
                !pending.some((seen) => seen.lockTxHash === lock.lockTxHash)
        );
        this.saveState({
            ...current,
            locksPending: [...stillPending, ...added],
        });
        if (stillPending.length && !quiet)
            this.log(
                `${stillPending.length} lock(s) pending: waiting for a proof, for their recipient's key, or retrying`
            );
    }

    /** True once the lock's deposit is minted on Tempo. */
    private async claimLock(lock: PendingLock): Promise<boolean> {
        if (
            lock.recipient.toLowerCase() !==
            this.tempo.signer.address.toLowerCase()
        )
            return false;
        const { proofQueue } = this.config.ethereum;
        const state = await withTimeout(
            getProofRequestStateSnapshot(this.connections, {
                proofQueueAddress: proofQueue,
                proofRequestTxHash: lock.lockTxHash,
                bridgeAddress: this.config.tempo.bridge,
            }),
            PROOF_REQUEST_TIMEOUT_MS,
            'reading the lock proof request'
        );
        if (state.state !== ProofRequestState.ProofAvailable) return false;

        const witness = await withTimeout(
            getVerifiedRequestWitness(
                this.connections.ethereum,
                state,
                proofQueue
            ),
            PROOF_REQUEST_TIMEOUT_MS,
            'reading the lock witness'
        );
        const [codeChallenge, tokenKey] = witness.value.collectionKeys;
        if (
            witness.value.target.toLowerCase() !==
                this.config.ethereum.tokenBridge.toLowerCase() ||
            witness.value.collectionKeysCount !== 2 ||
            tokenKey.toLowerCase() !==
                zeroPadValue(lock.ethToken, 32).toLowerCase() ||
            codeChallenge.toLowerCase() !==
                sha256(this.tempo.signer.address).toLowerCase()
        )
            throw new Error(
                `${lock.lockTxHash} is not a lock of ${lock.ethToken} for ${this.tempo.signer.address}`
            );

        const before = await this.tempoBridge.erc20MintedSoFar(
            lock.ethToken,
            lock.recipient
        );
        try {
            await mintERC20(
                this.tempo.signer,
                this.config.tempo.bridge,
                witness,
                state.proofQueueBatchIndex
            );
        } catch (error) {
            const name = contractErrorName(error, this.tempoBridge.interface);
            // A contract error is final for this lock; only transport errors retry
            if (name === undefined) throw error;
            if (name === ZERO_MINT_AMOUNT || name === MINTED_EXCEEDS_LOCKED) {
                this.log(
                    `${lock.name}: ${lock.lockTxHash} already minted by a later claim`
                );
                return true;
            }
            this.log(`${lock.name}: mintERC20 rejected (${name}); retrying`);
            return false;
        }
        const after = await this.tempoBridge.erc20MintedSoFar(
            lock.ethToken,
            lock.recipient
        );
        this.log(
            `${lock.name}: minted ${tip20Amount(after - before)} on Tempo to ${lock.recipient} (proof queue batch ${state.proofQueueBatchIndex})`
        );
        return true;
    }

    /**
     * Calls `NoriTokenBridge.syncPause` for each configured ERC-20 whose
     * `paused()` differs from the pause state the bridge last synced, paying
     * the queue fee, and keeps the transaction until `applyPauses` applies
     * its proof to the mirror. A token never synced counts as synced
     * unpaused, as a new mirror starts unpaused. Tokens without a mirror on
     * Tempo are skipped (`status` names them).
     */
    async syncPauses() {
        const bridge = this.tokenBridge();
        for (const token of this.config.tokens) {
            try {
                await this.syncPause(bridge, token);
            } catch (error) {
                this.log(
                    `${token.name}: pause sync failed: ${errorMessage(error)}`
                );
            }
        }
    }

    private async syncPause(bridge: NoriTokenBridge, token: MigrationToken) {
        if ((await this.tempoBridge.mirrorOf(token.ethToken)) === ZeroAddress)
            return;
        // A sync sent but not mined yet has not moved the bridge's pause state
        for (const pause of this.loadState().pausesPending) {
            if (
                pause.ethToken === token.ethToken &&
                !(await this.provider.getTransactionReceipt(
                    pause.syncPauseTxHash
                ))
            )
                return;
        }
        const erc20 = new Contract(token.ethToken, ERC20_ABI, this.provider);
        const [paused, synced] = await Promise.all([
            erc20.paused() as Promise<boolean>,
            bridge.pauseState(token.ethToken),
        ]);
        const wanted = paused ? PAUSE_STATE_PAUSED : PAUSE_STATE_UNPAUSED;
        if (synced === wanted || (synced === 0n && !paused)) return;

        const queue = NoriProofRequestQueue__factory.connect(
            await bridge.proofQueue(),
            this.provider
        );
        const tx = await bridge.syncPause(token.ethToken, {
            value: await queue.proofRequestQueueFee(),
        });
        // Pending as soon as it is sent, as a lock is
        const state = this.loadState();
        state.pausesPending.push({
            name: token.name,
            ethToken: token.ethToken,
            syncPauseTxHash: tx.hash,
        });
        this.saveState(state);
        try {
            const receipt = await tx.wait(1, ETHEREUM_WAIT_MS);
            this.log(
                `${token.name}: syncPause ${tx.hash}: paused ${paused}, block ${receipt?.blockNumber}`
            );
        } catch (error) {
            if (isError(error, 'CALL_EXCEPTION')) {
                const current = this.loadState();
                this.saveState({
                    ...current,
                    pausesPending: current.pausesPending.filter(
                        (pause) => pause.syncPauseTxHash !== tx.hash
                    ),
                });
                throw new Error(`syncPause ${tx.hash} reverted`);
            }
            this.log(
                `${token.name}: syncPause ${tx.hash}: not mined after ${ETHEREUM_WAIT_MS / 60_000} min; it is applied once it is`
            );
        }
    }

    /**
     * Applies each pending pause sync whose batch is proven to its mirror
     * with `NoriTempoTokenBridge.applyPause`. One a newer applied batch
     * supersedes is dropped; another rejection is logged and dropped; a
     * failure in transit is retried next round.
     */
    async applyPauses(quiet = false) {
        const pending = this.loadState().pausesPending;
        const stillPending: PendingPause[] = [];
        for (const pause of pending) {
            let done = false;
            try {
                done = await this.applyPendingPause(pause);
            } catch (error) {
                this.log(
                    `${pause.name}: applyPause of ${pause.syncPauseTxHash} failed: ${errorMessage(error)}`
                );
            }
            if (!done) stillPending.push(pause);
        }
        // Keep what another process (a CLI `sync-pauses`) added meanwhile
        const current = this.loadState();
        const added = current.pausesPending.filter(
            (pause) =>
                !pending.some(
                    (seen) => seen.syncPauseTxHash === pause.syncPauseTxHash
                )
        );
        this.saveState({
            ...current,
            pausesPending: [...stillPending, ...added],
        });
        if (stillPending.length && !quiet)
            this.log(
                `${stillPending.length} pause sync(s) pending: waiting for a proof or retrying`
            );
    }

    /** True once the pause state is applied to the mirror, or superseded. */
    private async applyPendingPause(pause: PendingPause): Promise<boolean> {
        const { proofQueue } = this.config.ethereum;
        const state = await withTimeout(
            getProofRequestStateSnapshot(this.connections, {
                proofQueueAddress: proofQueue,
                proofRequestTxHash: pause.syncPauseTxHash,
                bridgeAddress: this.config.tempo.bridge,
            }),
            PROOF_REQUEST_TIMEOUT_MS,
            'reading the pause proof request'
        );
        if (state.state !== ProofRequestState.ProofAvailable) return false;

        const witness = await withTimeout(
            getVerifiedRequestWitness(
                this.connections.ethereum,
                state,
                proofQueue
            ),
            PROOF_REQUEST_TIMEOUT_MS,
            'reading the pause witness'
        );
        if (
            witness.value.target.toLowerCase() !==
                this.config.ethereum.tokenBridge.toLowerCase() ||
            witness.value.collectionKeys[0].toLowerCase() !==
                PAUSE_KEY.toLowerCase()
        )
            throw new Error(
                `${pause.syncPauseTxHash} is not a pause request of the token bridge`
            );

        const { value } = witness.value;
        try {
            await applyPause(
                this.tempo.signer,
                this.config.tempo.bridge,
                witness,
                state.proofQueueBatchIndex
            );
            this.log(
                `${pause.name}: mirror ${value === PAUSE_STATE_PAUSED ? 'paused' : 'unpaused'} on Tempo (proof queue batch ${state.proofQueueBatchIndex})`
            );
        } catch (error) {
            const name = contractErrorName(error, this.tempoBridge.interface);
            // A contract error is final for this pause; only transport errors retry
            if (name === undefined) throw error;
            if (name !== PAUSE_NOT_NEWER)
                this.log(
                    `${pause.name}: applyPause rejected (${name}), dropped`
                );
        }
        return true;
    }

    /** Prints each token on both chains: pause states, and locked against minted. */
    async status() {
        for (const line of await this.statusLines()) this.log(line);
    }

    private async statusLines(): Promise<string[]> {
        const lines: string[] = [];
        const bridge = NoriTokenBridge__factory.connect(
            this.config.ethereum.tokenBridge,
            this.provider
        );
        const state = this.loadState();
        for (const token of this.config.tokens) {
            const erc20 = new Contract(
                token.ethToken,
                ERC20_ABI,
                this.provider
            );
            const [symbol, decimals, paused, lockedBU, mirror] =
                await Promise.all([
                    erc20.symbol() as Promise<string>,
                    erc20.decimals() as Promise<bigint>,
                    erc20.paused() as Promise<boolean>,
                    bridge.totalLockedERC20BU(token.ethToken),
                    this.tempoBridge.mirrorOf(token.ethToken),
                ]);
            lines.push(
                `${token.name}: Ethereum ${symbol} ${token.ethToken} | paused ${paused} | locked in the token bridge ${tip20Amount(lockedBU)} (${decimals} decimals there, 6 on Tempo)`
            );
            if (mirror === ZeroAddress) {
                lines.push(
                    `${token.name}: no mirror on Tempo yet; the issuer creates its TIP-20 and Nori adopts it (adopt-mirror), or Nori creates one (register-mirror)`
                );
                continue;
            }
            const tip20 = ITIP20__factory.connect(mirror, this.tempo.provider);
            const [mirrorPaused, supply, minted, bridgeIsAdmin, held] =
                await Promise.all([
                    tip20.paused(),
                    tip20.totalSupply(),
                    getErc20TotalMinted(
                        this.connections.tempo,
                        this.config.tempo.bridge,
                        token.ethToken
                    ),
                    tip20.hasRole(this.config.tempo.bridge, ZeroHash),
                    tip20.balanceOf(this.tempo.signer.address),
                ]);
            const unclaimed = lockedBU - minted;
            lines.push(
                `${token.name}: Tempo mirror ${mirror} (${bridgeIsAdmin ? 'created by the bridge' : "the issuer's own TIP-20"}) | paused ${mirrorPaused}` +
                    ` | minted ${tip20Amount(minted)} of ${tip20Amount(lockedBU)} locked, ${tip20Amount(unclaimed)} unclaimed` +
                    ` | supply ${tip20Amount(supply)} | ${this.tempo.signer.address} holds ${tip20Amount(held)}`
            );
            lines.push(
                `${token.name}: ${unclaimed >= 0n ? 'reconciled: minted never exceeds locked' : 'MISMATCH: minted exceeds locked'}` +
                    ` | ${paused === mirrorPaused ? 'pause in step' : 'pause differs (sync-pauses, then apply-pauses once proven)'}` +
                    ` | ${state.locksPending.filter((lock) => lock.ethToken === token.ethToken).length} lock(s) and ${state.pausesPending.filter((pause) => pause.ethToken === token.ethToken).length} pause sync(s) waiting`
            );
        }
        return lines;
    }

    /**
     * Claims proven locks, and syncs and applies pause states, every round,
     * forever, printing each status line when it changes: what a compliance
     * sync signer would do, with nothing to sign but fees.
     */
    async run() {
        const shown = new Set<string>();
        for (;;) {
            const jobs: Array<[string, () => Promise<void>]> = [
                ['claim', () => this.claim(true)],
                ['sync-pauses', () => this.syncPauses()],
                ['apply-pauses', () => this.applyPauses(true)],
            ];
            for (const [name, job] of jobs) {
                try {
                    await job();
                } catch (error) {
                    this.log(`${name} failed: ${errorMessage(error)}`);
                }
            }
            try {
                const lines = await this.statusLines();
                for (const line of lines) if (!shown.has(line)) this.log(line);
                shown.clear();
                for (const line of lines) shown.add(line);
            } catch (error) {
                this.log(`status failed: ${errorMessage(error)}`);
            }
            await new Promise((resolve) =>
                setTimeout(resolve, this.config.intervals.pollSecs * 1000)
            );
        }
    }
}
