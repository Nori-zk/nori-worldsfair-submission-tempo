import { Injectable } from '@yaw-rx/core';
import {
    combineLatest,
    EMPTY,
    filter,
    type Observable,
    pairwise,
    ReplaySubject,
    shareReplay,
    startWith,
    Subscription,
    switchMap,
    take,
    withLatestFrom,
} from 'rxjs';
import { ConnectionsService, ProofProgressService } from '@nori-zk/tempo-web-ui';
import {
    createMigrateMachine,
    type MigrateAddresses,
    type MigrateRequest,
} from '../ystate/migrate.impl.js';
import type { MigrateState } from '../ystate/migrate.js';

/** The migrate machine and its controls, started. */
export type MigrateMachine = ReturnType<typeof createMigrateMachine>;

/** The contracts this build migrates through, from `web/.env`. */
export const MIGRATE_ADDRESSES: MigrateAddresses = {
    ethToken: NORI_WEB_ENV.migration.ethToken,
    tokenBridge: NORI_WEB_ENV.ethereum.tokenBridgeAddress,
    proofQueue: NORI_WEB_ENV.ethereum.proofQueueAddress,
    tempoBridge: NORI_WEB_ENV.tempo.bridgeAddress,
};

/** The nodes where the owner (and a recipient left as the owner) follow the wallet's account. */
const FOLLOWS_ACCOUNT: MigrateState['node'][] = [
    'editing',
    'reading',
    'waitingForConnection',
    'readFailed',
    'readyToLock',
];

/**
 * Owns the migrate machine for the app's lifetime. It starts with the first
 * account the wallet shares, as the owner and the Tempo recipient; both then
 * follow the wallet's account until the user types another recipient. The
 * Tempo wallet, which signs the claim, is kept on the wallet the user chose
 * for Ethereum.
 */
@Injectable([ConnectionsService, ProofProgressService])
export class MigrateService {
    /** The running machine, once the wallet has shared an account. */
    readonly machine$ = new ReplaySubject<MigrateMachine>(1);
    /** The machine's states. */
    readonly state$: Observable<MigrateState> = this.machine$.pipe(
        switchMap(({ migrate }) => migrate.state$),
        shareReplay({ bufferSize: 1, refCount: false }),
    );
    private readonly subscriptions = new Subscription();
    private machine: MigrateMachine | undefined;

    /**
     * @param connections The connections, the wallets and the account.
     * @param proofProgress Follows each lock's proof request, as the progress view does.
     */
    constructor(connections: ConnectionsService, proofProgress: ProofProgressService) {
        this.subscriptions.add(
            connections.account$
                .pipe(
                    filter((account) => account !== ''),
                    take(1),
                )
                .subscribe((account) => {
                    const initial: MigrateRequest = {
                        amount: '',
                        recipient: account,
                        owner: account,
                    };
                    const machine = createMigrateMachine(
                        connections.connections,
                        MIGRATE_ADDRESSES,
                        (txHash) => proofProgress.follow(txHash).request$,
                        initial,
                    );
                    this.machine = machine;
                    this.machine$.next(machine);
                    machine.edit(initial);
                }),
        );
        this.subscriptions.add(
            connections.account$
                .pipe(
                    pairwise(),
                    withLatestFrom(this.state$.pipe(startWith(undefined))),
                    filter(
                        ([[previous, current], state]) =>
                            current !== '' &&
                            state !== undefined &&
                            state.data.owner === previous &&
                            FOLLOWS_ACCOUNT.includes(state.node),
                    ),
                )
                .subscribe(([[previous, current], state]) =>
                    this.machine?.edit({
                        amount: state?.data.amount ?? '',
                        recipient:
                            state?.data.recipient === previous
                                ? current
                                : (state?.data.recipient ?? current),
                        owner: current,
                    }),
                ),
        );
        // One browser wallet signs on both chains: the Tempo wallet takes the
        // one the user chose for Ethereum when several are installed.
        const tempoWallet = connections.connections.tempo.wallet;
        this.subscriptions.add(
            combineLatest([connections.walletState$, tempoWallet.connection?.state$ ?? EMPTY])
                .pipe(
                    filter(
                        ([ethereum, tempo]) =>
                            ethereum.node === 'ready' && tempo.node === 'choosingWallet',
                    ),
                )
                .subscribe(([ethereum]) => {
                    if (ethereum.node === 'ready')
                        tempoWallet.chooseWallet(ethereum.data.wallet.uuid);
                }),
        );
    }

    /**
     * Edits the request the machine holds.
     *
     * @param change The new request, from the current one.
     * @returns {void}
     */
    edit(change: (request: MigrateRequest) => MigrateRequest): void {
        this.state$
            .pipe(take(1))
            .subscribe(({ data }) =>
                this.machine?.edit(
                    change({ amount: data.amount, recipient: data.recipient, owner: data.owner }),
                ),
            );
    }

    /**
     * Stops the machine with the app.
     * @returns {void}
     */
    onDestroy(): void {
        this.subscriptions.unsubscribe();
        this.machine?.migrate.stop();
    }
}
