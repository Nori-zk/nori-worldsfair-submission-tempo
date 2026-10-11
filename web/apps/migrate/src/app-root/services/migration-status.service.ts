import { Injectable } from '@yaw-rx/core';
import { distinctUntilChanged, map, Observable, shareReplay, startWith, switchMap } from 'rxjs';
import { ZeroAddress } from 'ethers';
import { createMigrationMachine, type MigrationState } from '@nori-zk/backstop-keeper/migration';
import { ConnectionsService } from '@nori-zk/tempo-web-ui';
import { MIGRATE_ADDRESSES } from '../utils/addresses.js';

/**
 * The migration across both chains, kept current for the app's lifetime:
 * what is locked on Ethereum against what is minted on Tempo, the issuer's
 * pause on each, and the connected account's part, through the migration
 * read machine the CLI's `status` uses. Before the wallet shares an account
 * it reads the totals only; each new account starts a machine for it.
 */
@Injectable([ConnectionsService])
export class MigrationStatusService {
    /** The migration machine's states, for the account the wallet shares. */
    readonly state$: Observable<MigrationState>;

    /**
     * @param connections The connections and the wallet's account.
     */
    constructor(connections: ConnectionsService) {
        this.state$ = connections.accountState$.pipe(
            map(
                (state) =>
                    ('account' in state.data ? state.data.account : undefined) ?? ZeroAddress,
            ),
            startWith(ZeroAddress),
            distinctUntilChanged(),
            switchMap(
                (account) =>
                    new Observable<MigrationState>((subscriber) => {
                        const migration = createMigrationMachine(connections.connections, {
                            ethToken: MIGRATE_ADDRESSES.token,
                            tokenBridge: MIGRATE_ADDRESSES.tokenBridge,
                            tempoBridge: MIGRATE_ADDRESSES.tempoBridge,
                            holder: account,
                            recipient: account,
                        });
                        const subscription = migration.state$.subscribe(subscriber);
                        return () => {
                            subscription.unsubscribe();
                            migration.close();
                        };
                    }),
            ),
            shareReplay({ bufferSize: 1, refCount: true }),
        );
    }
}
