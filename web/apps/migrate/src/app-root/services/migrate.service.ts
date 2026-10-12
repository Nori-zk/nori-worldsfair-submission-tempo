import { Injectable } from '@yaw-rx/core';
import {
    combineLatest,
    distinctUntilChanged,
    filter,
    map,
    type Observable,
    shareReplay,
    type Subscription,
    take,
} from 'rxjs';
import { type EthereumWalletState, NoWalletConfiguredError } from '@nori-zk/nori-bridge-tempo-sdk';
import { ConnectionsService, ProofProgressService } from '@nori-zk/tempo-web-ui';
import { type LockToClaim } from '../machines/claim.js';
import { type ClaimMachine, createClaimMachine } from '../machines/claim.impl.js';
import { type LockState } from '../machines/lock.js';
import { createLockMachine, type LockMachine, requestOf } from '../machines/lock.impl.js';
import { type LockRequest } from '../machines/quote.js';
import { MIGRATE_ADDRESSES } from '../utils/addresses.js';

/**
 * The wallet a wallet machine runs on, once one is chosen.
 *
 * @param state The wallet machine's state.
 * @returns The wallet's id, or `undefined` before one is chosen.
 */
const chosenWalletOf = (state: EthereumWalletState): string | undefined =>
    'wallet' in state.data ? state.data.wallet.uuid : undefined;

/**
 * Runs the migration for the app's lifetime: the lock flow from the start
 * (it waits in `noAccount` until the wallet shares an account), and one
 * claim per lock it sends, kept for the app's lifetime so the view finds a
 * claim where it left it. The Tempo side signs through the same wallet the
 * user chose for Ethereum.
 */
@Injectable([ConnectionsService, ProofProgressService])
export class MigrateService {
    /** The running lock flow. */
    readonly lock: LockMachine;
    /** The claim of the lock the flow holds, while it holds one it sent. */
    readonly claim$: Observable<ClaimMachine | undefined>;
    private readonly claims = new Map<string, ClaimMachine>();
    private readonly tempoWalletFollows: Subscription;

    /**
     * @param connections The connections, the wallets and the Ethereum account.
     * @param proofProgress The proof requests followed, shared with the progress bar.
     * @throws {NoWalletConfiguredError} When the app's connections have no wallet.
     */
    constructor(
        private readonly connections: ConnectionsService,
        private readonly proofProgress: ProofProgressService,
    ) {
        const { account } = connections.wallet;
        if (account === undefined) throw new NoWalletConfiguredError();
        this.lock = createLockMachine(connections.connections, account, MIGRATE_ADDRESSES);
        this.claim$ = this.lock.state$.pipe(
            map((state) =>
                state.node === 'locked'
                    ? { txHash: state.data.txHash, recipient: state.data.recipient }
                    : undefined,
            ),
            distinctUntilChanged((before, now) => before?.txHash === now?.txHash),
            map((lock) => (lock === undefined ? undefined : this.claimOf(lock))),
            shareReplay({ bufferSize: 1, refCount: false }),
        );
        // While several wallets are installed, the Tempo wallet machine is
        // pointed at the one the user chose for Ethereum.
        const tempoWallet = connections.connections.tempo.wallet;
        this.tempoWalletFollows = combineLatest([
            connections.walletState$.pipe(map(chosenWalletOf)),
            tempoWallet.connection?.state$.pipe(map((state) => state.node === 'choosingWallet')) ??
                connections.walletState$.pipe(map(() => false)),
        ])
            .pipe(
                map(([chosen, choosing]) => (choosing ? chosen : undefined)),
                filter((chosen): chosen is string => chosen !== undefined),
                distinctUntilChanged(),
            )
            .subscribe((uuid) => tempoWallet.chooseWallet(uuid));
    }

    /** The lock flow's states. */
    get state$(): Observable<LockState> {
        return this.lock.state$;
    }

    /**
     * Edits the request the lock flow holds.
     *
     * @param change The new request, from the current one.
     * @returns {void}
     */
    edit(change: (request: LockRequest) => LockRequest): void {
        this.state$
            .pipe(
                take(1),
                map(requestOf),
                filter((request): request is LockRequest => request !== undefined),
            )
            .subscribe((request) => this.lock.edit(change(request)));
    }

    /**
     * The claim of a lock, started on its first call.
     *
     * @param lock The lock's transaction and recipient.
     * @returns The running claim.
     */
    private claimOf(lock: LockToClaim): ClaimMachine {
        const existing = this.claims.get(lock.txHash);
        if (existing) return existing;
        const claim = createClaimMachine(
            this.connections.connections,
            this.proofProgress.follow(lock.txHash).request$,
            lock,
            {
                proofQueue: MIGRATE_ADDRESSES.proofQueue,
                tempoBridge: MIGRATE_ADDRESSES.tempoBridge,
            },
        );
        this.claims.set(lock.txHash, claim);
        return claim;
    }

    /**
     * Closes the lock flow and every claim with the app.
     * @returns {void}
     */
    onDestroy(): void {
        this.tempoWalletFollows.unsubscribe();
        for (const claim of this.claims.values()) claim.close();
        this.claims.clear();
        this.lock.close();
        this.lock.stop();
    }
}
