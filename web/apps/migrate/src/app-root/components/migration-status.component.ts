import { Component, Inject, RxElement } from '@yaw-rx/core';
import { RxIf } from '@yaw-rx/core/directives/rx-if';
import { map, type Observable } from 'rxjs';
import { formatUnits } from 'ethers';
import { TIP20_DECIMALS } from '@nori-zk/tempo-token-bridge';
import {
    type MigrationStatus,
    MigrationStatusService,
} from '../services/migration-status.service.js';
import styles from './migration-status.component.css';

/**
 * An amount for display, with its symbol.
 *
 * @param amount The amount, in units of `decimals`.
 * @param decimals Its decimals.
 * @param symbol The token's symbol.
 * @returns The amount and symbol.
 */
const shown = (amount: bigint, decimals: number, symbol: string): string =>
    `${formatUnits(amount, decimals)} ${symbol}`;

/**
 * A value of the status for display, or "—" before the first read.
 *
 * @param status$ The status.
 * @param pick The value, from a read status.
 * @returns The value as text.
 */
const field = (
    status$: Observable<MigrationStatus | undefined>,
    pick: (status: MigrationStatus) => string,
): Observable<string> => status$.pipe(map((status) => (status ? pick(status) : '—')));

/**
 * The ERC-20 on Ethereum and its TIP-20 on Tempo, side by side: each one's
 * pause, what is locked and minted, and the user's balances, with the
 * reconciliation between them.
 */
@Component({
    selector: 'migration-status',
    directives: [RxIf],
    template: `
        <div class="chains">
            <div class="chain">
                <div class="chain-name">Ethereum · ERC-20, canonical</div>
                <div class="row">
                    <span>Paused</span><span [class.alert]="ethPausedFlag">{{ ethPaused }}</span>
                </div>
                <div class="row">
                    <span>Locked by everyone</span><span>{{ locked }}</span>
                </div>
                <div class="row">
                    <span>You hold</span><span>{{ ownerBalance }}</span>
                </div>
            </div>
            <div class="chain">
                <div class="chain-name">Tempo · TIP-20</div>
                <div class="row">
                    <span>Paused</span
                    ><span [class.alert]="tempoPausedFlag">{{ tempoPaused }}</span>
                </div>
                <div class="row">
                    <span>Minted by Nori</span><span>{{ minted }}</span>
                </div>
                <div class="row">
                    <span>Recipient holds</span><span>{{ recipientBalance }}</span>
                </div>
            </div>
        </div>
        <p class="note">{{ reconciliation }}</p>
        <p class="note">{{ mirror }}</p>
    `,
    styles,
})
export class MigrationStatusView extends RxElement {
    @Inject(MigrationStatusService) private readonly status!: MigrationStatusService;

    private get status$(): Observable<MigrationStatus | undefined> {
        return this.status.status$;
    }

    get ethPaused$(): Observable<string> {
        return field(this.status$, ({ paused }) => (paused ? 'Yes, by its issuer' : 'No'));
    }

    get ethPausedFlag$(): Observable<boolean> {
        return this.status$.pipe(map((status) => status?.paused === true));
    }

    get locked$(): Observable<string> {
        return field(this.status$, ({ locked, symbol }) => shown(locked, TIP20_DECIMALS, symbol));
    }

    get ownerBalance$(): Observable<string> {
        return field(this.status$, ({ ownerBalance, decimals, symbol }) =>
            shown(ownerBalance, decimals, symbol),
        );
    }

    get tempoPaused$(): Observable<string> {
        return field(this.status$, ({ mirror }) =>
            mirror === undefined ? '—' : mirror.paused ? 'Yes, by proof' : 'No',
        );
    }

    get tempoPausedFlag$(): Observable<boolean> {
        return this.status$.pipe(map((status) => status?.mirror?.paused === true));
    }

    get minted$(): Observable<string> {
        return field(this.status$, ({ mirror, symbol }) =>
            mirror === undefined ? '—' : shown(mirror.minted, TIP20_DECIMALS, symbol),
        );
    }

    get recipientBalance$(): Observable<string> {
        return field(this.status$, ({ mirror, symbol }) =>
            mirror === undefined ? '—' : shown(mirror.recipientBalance, TIP20_DECIMALS, symbol),
        );
    }

    /** Minted against locked: never more, and the rest waits to be claimed. */
    get reconciliation$(): Observable<string> {
        return this.status$.pipe(
            map((status) => {
                if (status?.mirror === undefined) return '';
                const unclaimed = status.locked - status.mirror.minted;
                return unclaimed < 0n
                    ? 'Minted exceeds locked: the mirror is not backed'
                    : `Reconciled: minted never exceeds locked; ${shown(unclaimed, TIP20_DECIMALS, status.symbol)} locked and not claimed yet`;
            }),
        );
    }

    /** Which TIP-20 mirrors the ERC-20, and who administers it. */
    get mirror$(): Observable<string> {
        return this.status$.pipe(
            map((status) => {
                if (status === undefined) return 'Reading both chains…';
                if (status.mirror === undefined)
                    return 'No TIP-20 mirrors this token on Tempo yet: its issuer creates one and Nori adopts it';
                const admin = status.mirror.issuerOwned
                    ? "the issuer's own TIP-20 (the issuer keeps its admin; Nori's bridge holds ISSUER_ROLE, PAUSE_ROLE and UNPAUSE_ROLE)"
                    : 'created by the bridge, its admin';
                return `TIP-20 ${status.mirror.address}: ${admin}`;
            }),
        );
    }
}
