import { formatUnits, Interface, isAddress, type JsonRpcProvider, parseUnits, toBeHex, Wallet, zeroPadValue } from 'ethers';
import {
    combineLatest,
    concatMap,
    defer,
    EMPTY,
    finalize,
    from,
    ignoreElements,
    map,
    type Observable,
    of,
    switchMap,
    take,
    takeWhile,
    tap,
} from 'rxjs';
import { NoriProofRequestQueue__factory, NoriTokenBridge__factory } from '@nori-zk/ethereum-tempo-bridge';
import {
    changesOf$,
    type ChainChanges,
    type ConnectionName,
    type Connections,
    createBridgeStateMachine,
    createChainChangesMachine,
    createProofQueueHeadMachine,
    mintERC20Call,
    type TransactionCall,
} from '@nori-zk/nori-bridge-tempo-sdk';
import { createFeeMachine } from '../keeper/fee.impl.js';
import { currentData$, currentOf$ } from '../keeper/reads.js';
import { type SendEnd, sendOnce$ } from '../keeper/sends.js';
import { loadStateFile, updateStateFile } from '../keeper/stateFile.js';
import { connectionsOf, createProvider } from '../keeper/tempo.js';
import { type ProvenCallState } from '../provenCall.js';
import { createProvenCallMachine } from '../provenCall.impl.js';
import { type MigrationConfig, type TokenEntry } from './config.js';
import { type MigrationState, type MigrationView } from './migrationView.js';
import { codeChallengeOf, createMigrationMachine } from './migrationView.impl.js';

/** The Tempo bridge's error for a claim with nothing new to mint: a later claim already minted the lock. */
const ZERO_MINT_AMOUNT = 'ZeroMintAmount';

/** A TIP-20 has 6 decimals; the token bridge counts in these bridge units. */
const TIP20_DECIMALS = 6;

const erc20Interface = new Interface(['function approve(address spender, uint256 amount) returns (bool)']);
const noriTokenBridgeInterface = NoriTokenBridge__factory.createInterface();

/** A `lockERC20` transaction whose lock is not claimed on Tempo yet. */
interface PendingLock {
    name: string;
    ethToken: string;
    /** The Tempo address the lock committed to: only it can claim. */
    recipient: string;
    lockTxHash: string;
}

interface MigrationFileState {
    locksPending: PendingLock[];
}

const NO_STATE: MigrationFileState = { locksPending: [] };

/** Bridge units (a TIP-20's 6 decimals) in words. */
const units = (amount: bigint) => formatUnits(amount, TIP20_DECIMALS);

/** An address shortened for a log line. */
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/**
 * Moves an Ethereum ERC-20 to its TIP-20 mirror on Tempo through
 * nori-tempo-sdk's token bridge: a holder locks it on Ethereum for a Tempo
 * recipient, Nori proves the lock, and the recipient claims the mirror. It
 * signs through its own signers (`ETH_PRIVATE_KEY`, the holder;
 * `TEMPO_PRIVATE_KEY`, the recipient) and reads through the sdk's
 * connections. The ERC-20's pause reaches the mirror through the keeper
 * (`sync-pauses`, `apply-pauses`).
 */
export class Migration {
    /** Each log of the Tempo bridge, a committed batch among them: what makes a proof request worth reading again. */
    private readonly bridgeLogs: ChainChanges;

    private constructor(
        private readonly config: MigrationConfig,
        private readonly connections: Connections,
        private readonly ethereumProvider: JsonRpcProvider,
        private readonly tempoProvider: JsonRpcProvider
    ) {
        this.bridgeLogs = createChainChangesMachine(connections.tempo, { address: config.tempo.bridge });
    }

    static connect(config: MigrationConfig): Migration {
        return new Migration(
            config,
            connectionsOf(config),
            createProvider(config.ethereum.rpcUrl),
            createProvider(config.tempo.rpcUrl)
        );
    }

    /** Closes the connections. */
    close() {
        this.bridgeLogs.close();
        this.connections.close();
    }

    private log(message: string) {
        console.log(`${new Date().toISOString()} ${message}`);
    }

    /** The holder: the Ethereum signer of approvals and locks. */
    private ethereumSigner(): Wallet {
        const key = process.env.ETH_PRIVATE_KEY;
        if (!key) throw new Error('Missing env: ETH_PRIVATE_KEY (the holder)');
        return new Wallet(key, this.ethereumProvider);
    }

    /** The recipient: the Tempo signer of claims. */
    private tempoSigner(): Wallet {
        const key = process.env.TEMPO_PRIVATE_KEY;
        if (!key) throw new Error('Missing env: TEMPO_PRIVATE_KEY (the recipient)');
        return new Wallet(key, this.tempoProvider);
    }

    private tokenNamed(name: string): TokenEntry {
        const token = this.config.tokens.find((entry) => entry.name === name);
        if (!token)
            throw new Error(`No token ${name} in the config (${this.config.tokens.map((entry) => entry.name).join(', ')})`);
        return token;
    }

    private loadState(): MigrationFileState {
        return loadStateFile(this.config.stateFile, NO_STATE);
    }

    private updateState(change: (state: MigrationFileState) => MigrationFileState) {
        updateStateFile(this.config.stateFile, NO_STATE, change);
    }

    private send$(
        chain: ConnectionName,
        signer: Wallet,
        call$: Observable<TransactionCall>,
        errors: Interface,
        sent?: (hash: string) => void
    ): Observable<SendEnd> {
        return sendOnce$(this.connections, chain, signer, call$, errors, this.config.intervals.pollSecs * 1000, sent);
    }

    /** One token's migration machine, for a holder on Ethereum and a recipient on Tempo. */
    private migrationMachine(token: TokenEntry, holder: string, recipient: string) {
        return createMigrationMachine(this.connections, {
            ethToken: token.ethToken,
            tokenBridge: this.config.ethereum.tokenBridge,
            tempoBridge: this.config.tempo.bridge,
            holder,
            recipient,
        });
    }

    /**
     * Locks `amount` of a configured ERC-20 on Ethereum for a Tempo
     * recipient: approves the token bridge first if it may not take the
     * amount yet, then `lockERC20`, paying the proof queue fee in ETH. The
     * lock is pending as soon as it is sent. A paused ERC-20 or too small a
     * balance sends nothing.
     *
     * @param name The token's name in the config.
     * @param amount In the token's units, at most 6 decimals (a TIP-20's).
     * @param recipient The Tempo address that claims (default: the `TEMPO_PRIVATE_KEY` address).
     */
    lock$(name: string, amount: string, recipient?: string): Observable<void> {
        return defer(() => {
            const token = this.tokenNamed(name);
            const holder = this.ethereumSigner();
            const to = recipient ?? this.tempoSigner().address;
            if (!isAddress(to)) throw new Error(`Invalid Tempo recipient: ${to}`);
            return currentOf$(this.migrationMachine(token, holder.address, to)).pipe(
                switchMap(({ migration }) => (migration ? this.lockQuoted$(token, migration, amount, holder, to) : EMPTY))
            );
        });
    }

    private lockQuoted$(
        token: TokenEntry,
        migration: MigrationView,
        amount: string,
        holder: Wallet,
        recipient: string
    ): Observable<void> {
        const { tokenBridge, proofQueue } = this.config.ethereum;
        const { symbol, decimals } = migration;
        const amountUnits = parseUnits(amount, decimals);
        const bridgeUnit = 10n ** (decimals - BigInt(TIP20_DECIMALS));
        if (amountUnits <= 0n || amountUnits % bridgeUnit !== 0n)
            throw new Error(`${amount} ${symbol}: a positive amount with at most 6 decimals (a TIP-20 has 6)`);
        if (migration.erc20Paused) {
            this.log(`${token.name}: ${symbol} is paused by its issuer on Ethereum; locks wait for the unpause`);
            return EMPTY;
        }
        if (migration.balance < amountUnits) {
            this.log(`${token.name}: ${short(holder.address)} holds ${formatUnits(migration.balance, decimals)} ${symbol}`);
            return EMPTY;
        }
        const approved$: Observable<SendEnd> =
            migration.allowance >= amountUnits
                ? of({ outcome: 'mined' })
                : this.send$(
                      'ethereum',
                      holder,
                      of({
                          to: token.ethToken,
                          data: erc20Interface.encodeFunctionData('approve', [tokenBridge, amountUnits]),
                          value: 0n,
                      }),
                      erc20Interface
                  );
        let lockTxHash = '';
        return approved$.pipe(
            switchMap((approved) => {
                if ('failed' in approved || approved.outcome !== 'mined') {
                    this.log(
                        `${token.name}: approve ${'failed' in approved ? `failed: ${approved.failed}` : approved.outcome}`
                    );
                    return EMPTY;
                }
                return this.send$(
                    'ethereum',
                    holder,
                    currentOf$(
                        createFeeMachine(this.connections, proofQueue, async (provider) =>
                            NoriProofRequestQueue__factory.connect(proofQueue, provider).proofRequestQueueFee()
                        )
                    ).pipe(
                        map(
                            ({ fee }): TransactionCall => ({
                                to: tokenBridge,
                                data: noriTokenBridgeInterface.encodeFunctionData('lockERC20', [
                                    token.ethToken,
                                    amountUnits,
                                    codeChallengeOf(recipient),
                                ]),
                                value: fee,
                            })
                        )
                    ),
                    noriTokenBridgeInterface,
                    (hash) => {
                        lockTxHash = hash;
                        this.updateState((state) => ({
                            locksPending: [
                                ...state.locksPending,
                                { name: token.name, ethToken: token.ethToken, recipient, lockTxHash: hash },
                            ],
                        }));
                    }
                ).pipe(
                    map((end) => {
                        if (!('failed' in end) && end.outcome === 'mined')
                            return this.log(
                                `${token.name}: locked ${amount} ${symbol} on Ethereum for ${recipient} (${lockTxHash})`
                            );
                        this.updateState((state) => ({
                            locksPending: state.locksPending.filter((lock) => lock.lockTxHash !== lockTxHash),
                        }));
                        this.log(`${token.name}: lockERC20 ${'failed' in end ? `failed: ${end.failed}` : end.outcome}`);
                    })
                );
            })
        );
    }

    /**
     * Follows a pending lock until it is claimed on Tempo: once Nori has
     * proven its batch, `mintERC20` with the recipient's signer mints what
     * is locked for the recipient and not minted yet. A claim the bridge
     * refuses for now (the mirror paused, its supply cap reached) stays
     * pending; one with nothing left to mint (a later claim minted it) is
     * done.
     *
     * @param lock The pending lock.
     * @param signer The recipient's Tempo signer.
     * @param untilWaiting Ends once it is looked up and its batch is not proven yet, as a one-off `claim` does.
     * @returns Its states, until it ends.
     */
    private claimOf$(lock: PendingLock, signer: Wallet, untilWaiting: boolean): Observable<ProvenCallState> {
        const { tokenBridge, proofQueue } = this.config.ethereum;
        const { bridge } = this.config.tempo;
        const recipientKey = toBeHex(codeChallengeOf(lock.recipient), 32);
        const tokenKey = zeroPadValue(lock.ethToken, 32).toLowerCase();
        const claim = createProvenCallMachine(
            this.connections,
            {
                proofRequestTxHash: lock.lockTxHash,
                proofQueue,
                tempoBridge: bridge,
                // The lock's `[codeChallenge, token]` leaf on the token bridge
                takes: ({ value }) =>
                    value.target.toLowerCase() === tokenBridge.toLowerCase() &&
                    value.collectionKeys[0].toLowerCase() === recipientKey &&
                    value.collectionKeys[1].toLowerCase() === tokenKey,
                callOf: (witness, proofQueueBatchIndex) => mintERC20Call(bridge, witness, proofQueueBatchIndex),
            },
            signer,
            this.config.intervals.pollSecs * 1000,
            changesOf$(this.bridgeLogs)
        );
        const ended = (state: ProvenCallState) =>
            state.node === 'called' ||
            state.node === 'otherRequest' ||
            state.node === 'transactionReplaced' ||
            state.node === 'transactionDropped' ||
            (untilWaiting && state.node === 'waitingForProof');
        const drop = () =>
            this.updateState((current) => ({
                locksPending: current.locksPending.filter(({ lockTxHash }) => lockTxHash !== lock.lockTxHash),
            }));
        return claim.state$.pipe(
            tap((state) => {
                if (untilWaiting && state.node === 'waitingForProof')
                    this.log(`${lock.name}: ${lock.lockTxHash} waiting for Nori to prove it; claim again then`);
                if (state.node === 'otherRequest') {
                    this.log(`${lock.name}: ${lock.lockTxHash} is not a lock of ${lock.ethToken} for ${lock.recipient}, dropped`);
                    drop();
                }
                if (state.node === 'transactionReplaced' || state.node === 'transactionDropped') {
                    this.log(
                        `${lock.name}: ${lock.lockTxHash} ${state.node === 'transactionReplaced' ? 'replaced' : 'dropped'}, no lock, dropped`
                    );
                    drop();
                }
                if (state.node !== 'called') return;
                const { outcome, value, proofQueueBatchIndex } = state.data;
                if (outcome === 'mined') {
                    this.log(
                        `${lock.name}: claimed on Tempo by ${lock.recipient}: ${units(value)} locked for it in all, minted (proof queue batch ${proofQueueBatchIndex})`
                    );
                    drop();
                } else if (outcome === ZERO_MINT_AMOUNT) {
                    this.log(`${lock.name}: ${lock.lockTxHash} already minted by a later claim`);
                    drop();
                } else this.log(`${lock.name}: mintERC20 ${outcome}; stays pending, claim again later`);
            }),
            takeWhile((state) => !ended(state), true),
            finalize(() => claim.close())
        );
    }

    /** Claims each pending lock for the `TEMPO_PRIVATE_KEY` address whose batch is proven, and leaves the rest pending. */
    claim$(): Observable<void> {
        return defer(() => {
            const signer = this.tempoSigner();
            const mine = this.loadState().locksPending.filter(
                ({ recipient }) => recipient.toLowerCase() === signer.address.toLowerCase()
            );
            if (mine.length === 0) this.log(`No pending lock for ${signer.address}`);
            return from(mine).pipe(
                concatMap((lock) => this.claimOf$(lock, signer, true)),
                ignoreElements()
            );
        });
    }

    /**
     * One token's status line: its issuer's pause on both chains, what is
     * locked on Ethereum against what is minted on Tempo, and the
     * recipient's part of it.
     */
    private tokenLine(token: TokenEntry, recipient: string | undefined, migration: MigrationView | undefined): string {
        if (!migration) return `${token.name}: not read yet`;
        const { symbol, erc20Paused, totalLocked, totalMinted, mirror, mirrorPaused } = migration;
        const waiting = this.loadState().locksPending.filter(({ ethToken }) => ethToken === token.ethToken).length;
        const ethereum = `${symbol} on Ethereum paused ${erc20Paused}`;
        if (!mirror)
            return `${token.name}: ${ethereum} | no mirror on Tempo yet: the issuer creates its TIP-20, Nori adopts it`;
        const reconciled = totalMinted === totalLocked ? 'reconciled' : `${units(totalLocked - totalMinted)} not claimed yet`;
        return (
            `${token.name}: ${ethereum} | Tempo mirror ${mirror} paused ${mirrorPaused}` +
            ` | minted ${units(totalMinted)} of ${units(totalLocked)} locked, ${reconciled}` +
            (recipient
                ? ` | ${short(recipient)}: ${units(migration.lockedForRecipient)} locked for it, holds ${units(migration.recipientBalance)}`
                : '') +
            ` | ${waiting} lock(s) waiting`
        );
    }

    /** Prints Nori's progress through the proof queue, then each token's migration. */
    status$(): Observable<void> {
        return defer(() => {
            const holder = process.env.ETH_PRIVATE_KEY ? this.ethereumSigner().address : undefined;
            const recipient = process.env.TEMPO_PRIVATE_KEY ? this.tempoSigner().address : undefined;
            const zero = '0x0000000000000000000000000000000000000000';
            const bridgeState = createBridgeStateMachine(this.connections, this.config.tempo.bridge);
            const queueHead = createProofQueueHeadMachine(this.connections, this.config.ethereum.proofQueue);
            const tokens = this.config.tokens.map((token) => ({
                token,
                machine: this.migrationMachine(token, holder ?? zero, recipient ?? zero),
            }));
            return combineLatest([
                currentData$(bridgeState),
                currentData$(queueHead),
                tokens.length
                    ? combineLatest(tokens.map(({ machine }) => currentData$<MigrationState>(machine)))
                    : of([]),
            ]).pipe(
                take(1),
                map(([{ bridgeState: nori }, { head }, read]) => [
                    nori
                        ? `nori: ${nori.queueCursor} of ${head} queue requests proven | ${nori.proofQueueBatchCount} batches`
                        : `nori: no bridge state at ${this.config.tempo.bridge}`,
                    ...tokens.map(({ token }, i) => this.tokenLine(token, recipient, read[i].migration)),
                ]),
                map((lines) => lines.forEach((line) => this.log(line))),
                finalize(() => {
                    bridgeState.close();
                    queueHead.close();
                    tokens.forEach(({ machine }) => machine.close());
                })
            );
        });
    }
}
