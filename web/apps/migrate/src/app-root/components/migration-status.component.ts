import { Component, Inject, RxElement } from '@yaw-rx/core';
import { RxIf } from '@yaw-rx/core/directives/rx-if';
import { combineLatest, map, type Observable } from 'rxjs';
import type { MigrationState, MigrationView } from '@nori-zk/backstop-keeper/migration';
import { ConnectionsService, tokenAmountText } from '@nori-zk/tempo-web-ui';
import { MigrationStatusService } from '../services/migration-status.service.js';
import styles from './migration-status.component.css';

/** A TIP-20 has 6 decimals; the bridges count locked and minted amounts in these units. */
const TIP20_DECIMALS = 6;

/**
 * The migration the machine holds, once read.
 *
 * @param state The migration machine's state.
 * @returns The migration, or `undefined` before it is read.
 */
const migrationOf = (state: MigrationState): MigrationView | undefined =>
    'migration' in state.data ? state.data.migration : undefined;

/**
 * The migration across both chains, kept current: what is locked on
 * Ethereum against what is minted on Tempo, the issuer's pause on each
 * chain, and the connected account's part on Tempo. Locked never falls
 * below minted: every mint rests on a proof of a lock.
 */
@Component({
    selector: 'migration-status',
    directives: [RxIf],
    template: `
        <h3>{{ heading }}</h3>
        <dl>
            <div>
                <dt>Locked on Ethereum</dt>
                <dd>{{ locked }}</dd>
            </div>
            <div>
                <dt>Minted on Tempo</dt>
                <dd>{{ minted }}</dd>
            </div>
            <div>
                <dt>Issuer's pause</dt>
                <dd>{{ pause }}</dd>
            </div>
            <div rx-if="connected">
                <dt>You hold on Tempo</dt>
                <dd>{{ held }}</dd>
            </div>
        </dl>
        <p class="note">{{ note }}</p>
    `,
    styles,
})
export class MigrationStatus extends RxElement {
    @Inject(MigrationStatusService) private readonly status!: MigrationStatusService;
    @Inject(ConnectionsService) private readonly connections!: ConnectionsService;

    private get migration$(): Observable<MigrationView | undefined> {
        return this.status.state$.pipe(map(migrationOf));
    }

    /**
     * An amount in bridge units (6 decimals) in words, or "—" before it is read.
     *
     * @param pick The amount, from the migration.
     * @returns The amount, as it changes.
     */
    private amount$(pick: (migration: MigrationView) => bigint): Observable<string> {
        return this.migration$.pipe(
            map((migration) =>
                migration === undefined
                    ? '—'
                    : tokenAmountText(pick(migration), TIP20_DECIMALS, migration.symbol),
            ),
        );
    }

    get heading$(): Observable<string> {
        return this.migration$.pipe(
            map((migration) => `${migration?.symbol ?? 'The token'} across Ethereum and Tempo`),
        );
    }

    get locked$(): Observable<string> {
        return this.amount$(({ totalLocked }) => totalLocked);
    }

    get minted$(): Observable<string> {
        return this.amount$(({ totalMinted }) => totalMinted);
    }

    get held$(): Observable<string> {
        return this.amount$(({ recipientBalance }) => recipientBalance);
    }

    /** The ERC-20's pause on Ethereum, and its TIP-20's on Tempo, which follows it by proof. */
    get pause$(): Observable<string> {
        return this.migration$.pipe(
            map((migration) => {
                if (migration === undefined) return '—';
                const ethereum = migration.erc20Paused ? 'paused' : 'not paused';
                if (migration.mirror === undefined) return `Ethereum: ${ethereum}`;
                const tempo = migration.mirrorPaused === true ? 'paused' : 'not paused';
                return `Ethereum: ${ethereum} · Tempo: ${tempo}`;
            }),
        );
    }

    get connected$(): Observable<boolean> {
        return this.connections.accountState$.pipe(
            map((state) => 'account' in state.data && state.data.account !== undefined),
        );
    }

    /** What the numbers mean, or what is missing. */
    get note$(): Observable<string> {
        return combineLatest([this.migration$, this.status.state$]).pipe(
            map(([migration, state]) => {
                if (migration === undefined)
                    return state.node.startsWith('failed')
                        ? 'Reading both chains again shortly'
                        : 'Reading both chains';
                if (migration.mirror === undefined)
                    return `No TIP-20 on Tempo for ${migration.symbol} yet: its issuer creates one, and Nori adopts it`;
                const unclaimed = migration.totalLocked - migration.totalMinted;
                if (unclaimed === 0n)
                    return 'Reconciled: everything locked on Ethereum is minted on Tempo, and nothing more';
                return `${tokenAmountText(unclaimed, TIP20_DECIMALS, migration.symbol)} locked and proven or on its way, not claimed yet; Tempo never mints more than is locked`;
            }),
        );
    }
}
