import { Component, Inject, RxElement } from '@yaw-rx/core';
import { RxIf } from '@yaw-rx/core/directives/rx-if';
import { combineLatest, map, type Observable, take } from 'rxjs';
import { formatEther, formatUnits } from 'ethers';
import { ConnectionsService } from '@nori-zk/tempo-web-ui';
import type { MigrateRequest } from '../ystate/migrate.impl.js';
import type { MigrateState } from '../ystate/migrate.js';
import { type MigrateMachine, MigrateService } from '../services/migrate.service.js';
import { MigrationStatusService } from '../services/migration-status.service.js';
import styles from './migrate-form.component.css';

/**
 * Whether the machine is at one of `nodes`.
 *
 * @param nodes The nodes.
 * @returns A predicate on states.
 */
const atNode =
    (...nodes: MigrateState['node'][]) =>
    (state: MigrateState): boolean =>
        nodes.includes(state.node);

/** The nodes after the lock is sent: its proof is followed, then claimed. */
const AFTER_LOCK: MigrateState['node'][] = ['proving', 'claimable', 'claiming', 'claimed'];

/** The nodes that carry a quote. */
type Quoted = Extract<MigrateState, { data: { units: bigint } }>;

/**
 * Whether a state carries the quote read for its request.
 *
 * @param state The machine's state.
 * @returns Whether it has a quote.
 */
const isQuoted = (state: MigrateState): state is Quoted => 'units' in state.data;

/**
 * Why a quoted lock cannot go ahead, or an empty string when it can.
 *
 * @param state A quoted state.
 * @returns The reason.
 */
const blocker = ({ data }: Quoted): string => {
    if (data.paused)
        return `${data.symbol} is paused by its issuer on Ethereum: locks wait for the unpause`;
    if (data.balance < data.units)
        return `You hold ${formatUnits(data.balance, data.decimals)} ${data.symbol}`;
    return '';
};

/**
 * The form for migrating: the amount and the Tempo recipient, the lock's
 * quote as soon as both are valid, the lock sent from the wallet, its proof
 * followed to Tempo, and the claim there. It opens once the wallet has
 * shared an account, with that account as the recipient.
 */
@Component({
    selector: 'migrate-form',
    directives: [RxIf],
    template: `
        <p class="message" rx-if="disconnected">Connect your Ethereum wallet above to migrate.</p>
        <div rx-if="editable">
            <label
                >Amount
                <input
                    [value]="amount"
                    [disabled]="locked"
                    placeholder="0.0"
                    inputmode="decimal"
                    oninput="onAmount($event)"
                />
            </label>
            <label
                >Tempo recipient (only it can claim)
                <input
                    [value]="recipient"
                    [disabled]="locked"
                    placeholder="0x…"
                    oninput="onRecipient($event)"
                />
            </label>
            <div class="summary">
                <div class="stat">
                    <span class="stat-label">Locked on Ethereum</span>
                    <span class="stat-value"
                        ><span rx-if="reading"><span class="spinner"></span></span
                        >{{ lockAmount }}</span
                    >
                </div>
                <div class="stat">
                    <span class="stat-label">Minted on Tempo</span>
                    <span class="stat-value">{{ netAmount }}</span>
                </div>
            </div>
            <p class="fine">{{ fees }}</p>
            <div class="actions" rx-if="lockShown">
                <button [disabled]="lockDisabled" onclick="act">{{ lockLabel }}</button>
            </div>
            <p class="message">{{ message }}</p>
        </div>
        <div rx-if="afterLock">
            <proof-progress [txHash]="txHash"></proof-progress>
            <div class="actions" rx-if="claimShown">
                <button [disabled]="claimDisabled" onclick="claim">{{ claimLabel }}</button>
            </div>
            <div class="actions" rx-if="claimed">
                <button class="secondary" onclick="another">Migrate more</button>
            </div>
            <p class="message">{{ claimMessage }}</p>
        </div>
    `,
    styles,
})
export class MigrateForm extends RxElement {
    @Inject(ConnectionsService) private readonly connections!: ConnectionsService;
    @Inject(MigrateService) private readonly migrate!: MigrateService;
    @Inject(MigrationStatusService) private readonly status!: MigrationStatusService;

    private get state$(): Observable<MigrateState> {
        return this.migrate.state$;
    }

    get disconnected$(): Observable<boolean> {
        return combineLatest([this.connections.ready$, this.connections.account$]).pipe(
            map(([ready, account]) => !ready || account === ''),
        );
    }

    get editable$(): Observable<boolean> {
        return combineLatest([this.disconnected$, this.state$]).pipe(
            map(([disconnected]) => !disconnected),
        );
    }

    /** Whether the form is fixed: the wallet is asked to sign, or the lock is under way. */
    get locked$(): Observable<boolean> {
        return this.state$.pipe(map(atNode('awaitingSignature', ...AFTER_LOCK)));
    }

    get amount$(): Observable<string> {
        return this.state$.pipe(map(({ data }) => data.amount));
    }

    get recipient$(): Observable<string> {
        return this.state$.pipe(map(({ data }) => data.recipient));
    }

    get reading$(): Observable<boolean> {
        return this.state$.pipe(map(atNode('reading')));
    }

    /** The amount the lock takes, nothing while reading, or "—" before there is a quote. */
    get lockAmount$(): Observable<string> {
        return this.state$.pipe(
            map((state) =>
                isQuoted(state)
                    ? `${formatUnits(state.data.units, state.data.decimals)} ${state.data.symbol}`
                    : state.node === 'reading'
                      ? ''
                      : '—',
            ),
        );
    }

    /** The TIP-20 the recipient claims: the amount net of the bridge's rate fee, 6 decimals. */
    get netAmount$(): Observable<string> {
        return this.state$.pipe(
            map((state) =>
                isQuoted(state)
                    ? `${formatUnits(state.data.net, state.data.decimals)} ${state.data.symbol}`
                    : '—',
            ),
        );
    }

    get fees$(): Observable<string> {
        return this.state$.pipe(
            map((state) =>
                isQuoted(state)
                    ? `Bridge fee ${formatUnits(state.data.fee, state.data.decimals)} ${state.data.symbol} · proof queue fee ${formatEther(state.data.queueFee)} ETH · ${state.data.decimals.toString()} decimals on Ethereum, 6 on Tempo`
                    : '',
            ),
        );
    }

    /** The lock button stays in place until the lock is sent. */
    get lockShown$(): Observable<boolean> {
        return this.state$.pipe(map((state) => !atNode(...AFTER_LOCK)(state)));
    }

    get lockLabel$(): Observable<string> {
        return this.state$.pipe(
            map((state) =>
                state.node === 'readFailed'
                    ? 'Read again'
                    : state.node === 'awaitingSignature'
                      ? 'Confirming in your wallet…'
                      : 'Lock on Ethereum',
            ),
        );
    }

    /** Enabled when there is something to do: lock a quote nothing blocks, or read again. */
    get lockDisabled$(): Observable<boolean> {
        return this.state$.pipe(
            map((state) =>
                state.node === 'readFailed'
                    ? false
                    : !atNode('readyToLock', 'declined', 'sendFailed')(state) ||
                      !isQuoted(state) ||
                      blocker(state) !== '',
            ),
        );
    }

    /** What the user is waiting on or what went wrong, for the node the machine is at. */
    get message$(): Observable<string> {
        return this.state$.pipe(
            map((state) => {
                switch (state.node) {
                    case 'editing':
                        return 'Enter an amount (at most 6 decimals, a TIP-20 has 6) and a Tempo address';
                    case 'waitingForConnection':
                        return `Waiting for ${state.data.waitingOn.join(' and ')}`;
                    case 'readFailed':
                        return state.data.error;
                    case 'readyToLock':
                        return (
                            blocker(state) ||
                            'Locked for good: the bridge has no unlock path, so the supply retires on Ethereum'
                        );
                    case 'declined':
                        return 'You cancelled the transaction in your wallet';
                    case 'sendFailed':
                        return state.data.error;
                    case 'reading':
                    case 'awaitingSignature':
                    case 'proving':
                    case 'claimable':
                    case 'claiming':
                    case 'claimed':
                        return '';
                }
            }),
        );
    }

    get afterLock$(): Observable<boolean> {
        return this.state$.pipe(map(atNode(...AFTER_LOCK)));
    }

    get txHash$(): Observable<string> {
        return this.state$.pipe(map(({ data }) => ('txHash' in data ? data.txHash : '')));
    }

    get claimShown$(): Observable<boolean> {
        return this.state$.pipe(map(atNode('claimable', 'claiming')));
    }

    get claimDisabled$(): Observable<boolean> {
        return this.state$.pipe(map((state) => state.node !== 'claimable'));
    }

    get claimLabel$(): Observable<string> {
        return this.state$.pipe(
            map((state) =>
                state.node === 'claiming'
                    ? 'Confirming in your wallet on Tempo…'
                    : 'Claim on Tempo',
            ),
        );
    }

    get claimed$(): Observable<boolean> {
        return this.state$.pipe(map(atNode('claimed')));
    }

    /** Where the claim stands. */
    get claimMessage$(): Observable<string> {
        return this.state$.pipe(
            map((state) => {
                if (!isQuoted(state)) return '';
                const net = `${formatUnits(state.data.net, state.data.decimals)} ${state.data.symbol}`;
                switch (state.node) {
                    case 'proving':
                        return `Nori proves the lock once Ethereum finalizes it; then ${state.data.recipient} claims ${net}`;
                    case 'claimable':
                        return (
                            state.data.claimError ||
                            `Proven on Tempo: claim ${net} as ${state.data.recipient}`
                        );
                    case 'claiming':
                        return 'Your wallet switches to Tempo and sends mintERC20';
                    case 'claimed':
                        // A claim mints all that is locked for the recipient and not minted yet
                        return state.data.claimTxHash
                            ? `Claimed on Tempo (${state.data.claimTxHash}): everything locked for ${state.data.recipient} is minted`
                            : `Already claimed: everything locked for ${state.data.recipient} is on Tempo`;
                    case 'readyToLock':
                    case 'awaitingSignature':
                    case 'declined':
                    case 'sendFailed':
                        return '';
                }
            }),
        );
    }

    onAmount(event: Event): void {
        const amount = (event.target as HTMLInputElement).value.trim();
        this.migrate.edit((request) => ({ ...request, amount }));
    }

    onRecipient(event: Event): void {
        const recipient = (event.target as HTMLInputElement).value.trim();
        this.migrate.edit((request: MigrateRequest) => ({ ...request, recipient }));
    }

    /** The lock button: reads again after a failed read, otherwise locks. */
    act(): void {
        this.state$
            .pipe(take(1))
            .subscribe((state) =>
                this.control((machine) =>
                    state.node === 'readFailed' ? machine.retry() : machine.lock(),
                ),
            );
    }

    claim(): void {
        this.control((machine) => machine.claim());
    }

    another(): void {
        this.control((machine) => machine.another());
        this.status.refresh();
    }

    /**
     * Calls one of the running machine's controls.
     *
     * @param call The control to call.
     * @returns {void}
     */
    private control(call: (machine: MigrateMachine) => void): void {
        this.migrate.machine$.pipe(take(1)).subscribe(call);
    }
}
