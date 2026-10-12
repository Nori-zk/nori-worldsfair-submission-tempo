import { Component, Inject, RxElement } from '@yaw-rx/core';
import { RxIf } from '@yaw-rx/core/directives/rx-if';
import { map, NEVER, type Observable, of, switchMap, take } from 'rxjs';
import { tokenAmountText } from '@nori-zk/tempo-web-ui';
import type { ClaimState } from '../machines/claim.js';
import { type ClaimMachine } from '../machines/claim.impl.js';
import type { LockState } from '../machines/lock.js';
import { quoteOf, requestOf } from '../machines/lock.impl.js';
import type { LockRequest, Quote } from '../machines/quote.js';
import { lockBlocker } from '../machines/quote.impl.js';
import { MigrateService } from '../services/migrate.service.js';
import styles from './migrate-form.component.css';

/** The nodes of the lock flow; a node's own name. */
type Node = LockState['node'];

/** The nodes where the quote is being read for the request the form holds, before any is held. */
const FIRST_READ: Node[] = ['loading', 'waitingForConnectionWhileLoading'];

/** The nodes `lock` leaves from: a quote is held, or a send can be tried again. */
const LOCKABLE: Node[] = ['current', 'refreshing', 'declined', 'sendFailed', 'reverted'];

/** What the user can do next, in words, for each node of the lock flow. */
const MESSAGE: Record<Node, string> = {
    noAccount: '',
    editing: 'Enter an amount (at most 6 decimals: a TIP-20 has 6) and a Tempo address',
    loading: '',
    current: '',
    refreshing: '',
    waitingForConnectionWhileLoading: '',
    waitingForConnectionWhileRefreshing: '',
    failedWhileLoading: 'No quote could be read for this amount yet · trying again',
    failedWhileRefreshing: 'The quote could not be read again yet · trying again',
    closed: '',
    approving:
        'First your wallet approves the bridge to take the amount, then it asks you to lock it',
    signing: '',
    declined: 'You cancelled the transaction in your wallet',
    sendFailed: 'The transaction did not go through · send it again or change the amount',
    locked: '',
    reverted: 'The lock did not go through · send it again or change the amount',
};

/** The nodes where a claim holds the lock's witness: it can be claimed (again). */
const CLAIMABLE: ClaimState['node'][] = ['claimable', 'claimDeclined', 'claimFailed'];

/** The nodes where the migration of this lock is over. */
const DONE: ClaimState['node'][] = ['claimed', 'alreadyClaimed'];

/**
 * Why a claim did not go through, in words.
 *
 * @param error The error that refused it, or how it was lost.
 * @param recipient The address the lock committed to.
 * @returns The reason and what to do.
 */
const claimFailureText = (error: string, recipient: string): string => {
    switch (error) {
        case 'ContractPaused':
            return 'The token is paused on Tempo, following its issuer on Ethereum · claim again once it is unpaused';
        case 'CommitmentMismatch':
            return `Only ${recipient} can claim: switch your wallet to that account, then claim again`;
        case 'reverted':
        case 'sendFailed':
        case 'replaced':
        case 'dropped':
            return 'The claim did not go through · claim again';
        default:
            return 'The bridge refused the claim for now · claim again';
    }
};

/**
 * The form for migrating: the amount and the Tempo recipient, the quote as
 * soon as both are valid, the lock sent from the wallet on Ethereum, its
 * proof followed to Tempo, and the claim there. Each part shows for its
 * flow's node: the lock flow until the lock is sent, then the lock's claim.
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
                    [disabled]="busy"
                    placeholder="0.0"
                    inputmode="decimal"
                    oninput="onAmount($event)"
                />
            </label>
            <label
                >Tempo recipient (only it can claim)
                <input
                    [value]="recipient"
                    [disabled]="busy"
                    placeholder="0x…"
                    oninput="onRecipient($event)"
                />
            </label>
            <div class="summary">
                <div class="stat">
                    <span class="stat-label">You lock on Ethereum</span>
                    <span class="stat-value"
                        ><span rx-if="reading"><span class="spinner"></span></span
                        >{{ lockAmount }}</span
                    >
                </div>
                <div class="stat">
                    <span class="stat-label">You claim on Tempo</span>
                    <span class="stat-value">{{ netAmount }}</span>
                </div>
            </div>
            <p class="fine">{{ fees }}</p>
            <div class="actions">
                <button [disabled]="lockDisabled" onclick="lock">{{ lockLabel }}</button>
            </div>
            <p class="message">{{ message }}</p>
        </div>
        <div rx-if="claiming">
            <proof-progress [txHash]="txHash"></proof-progress>
            <div class="actions" rx-if="claimShown">
                <button [disabled]="claimDisabled" onclick="claim">{{ claimLabel }}</button>
            </div>
            <div class="actions" rx-if="done">
                <button class="secondary" onclick="another">Migrate more</button>
            </div>
            <p class="message">{{ claimMessage }}</p>
        </div>
    `,
    styles,
})
export class MigrateForm extends RxElement {
    @Inject(MigrateService) private readonly migrate!: MigrateService;

    private get state$(): Observable<LockState> {
        return this.migrate.state$;
    }

    /** The claim of the lock sent, with its state, or `undefined` before one is sent. */
    private get claimState$(): Observable<ClaimState | undefined> {
        return this.migrate.claim$.pipe(
            switchMap((claim: ClaimMachine | undefined) =>
                claim === undefined ? of(undefined) : claim.state$,
            ),
        );
    }

    /**
     * The request the flow holds, or an empty one once it is closed.
     *
     * @returns The amount, recipient and holder.
     */
    private get request$(): Observable<LockRequest> {
        return this.state$.pipe(
            map((state) => requestOf(state) ?? { amount: '', recipient: '', holder: '' }),
        );
    }

    /** The quote and the node it is held at. */
    private get quoted$(): Observable<{ node: Node; quote: Quote | undefined }> {
        return this.state$.pipe(map((state) => ({ node: state.node, quote: quoteOf(state) })));
    }

    get disconnected$(): Observable<boolean> {
        return this.state$.pipe(map(({ node }) => node === 'noAccount'));
    }

    /** The lock form shows until the lock is sent. */
    get editable$(): Observable<boolean> {
        return this.state$.pipe(
            map(({ node }) => node !== 'noAccount' && node !== 'closed' && node !== 'locked'),
        );
    }

    /** Whether the form is fixed: the wallet is asked to approve or sign. */
    get busy$(): Observable<boolean> {
        return this.state$.pipe(map(({ node }) => node === 'approving' || node === 'signing'));
    }

    get amount$(): Observable<string> {
        return this.request$.pipe(map(({ amount }) => amount));
    }

    get recipient$(): Observable<string> {
        return this.request$.pipe(map(({ recipient }) => recipient));
    }

    get reading$(): Observable<boolean> {
        return this.state$.pipe(map(({ node }) => FIRST_READ.includes(node)));
    }

    /** The amount the lock takes, nothing while it is read, or "—" before there is a quote. */
    get lockAmount$(): Observable<string> {
        return this.quoted$.pipe(
            map(({ node, quote }) => {
                if (quote !== undefined)
                    return tokenAmountText(quote.units, quote.decimals, quote.symbol);
                return FIRST_READ.includes(node) ? '' : '—';
            }),
        );
    }

    /** What the recipient claims on Tempo: the amount net of the bridge's rate fee. */
    get netAmount$(): Observable<string> {
        return this.quoted$.pipe(
            map(({ quote }) =>
                quote === undefined
                    ? '—'
                    : tokenAmountText(quote.net, quote.decimals, quote.symbol),
            ),
        );
    }

    get fees$(): Observable<string> {
        return this.quoted$.pipe(
            map(({ quote }) =>
                quote === undefined
                    ? ''
                    : `Bridge fee ${tokenAmountText(quote.fee, quote.decimals, quote.symbol)} · proof queue fee ${tokenAmountText(quote.queueFee, 18, 'ETH')} · ${quote.decimals.toString()} decimals on Ethereum, 6 on Tempo`,
            ),
        );
    }

    get lockLabel$(): Observable<string> {
        return this.quoted$.pipe(
            map(({ node, quote }) => {
                if (node === 'approving') return 'Approve in your wallet…';
                if (node === 'signing') return 'Confirm the lock in your wallet…';
                return quote !== undefined && quote.allowance < quote.units
                    ? 'Approve and lock'
                    : 'Lock on Ethereum';
            }),
        );
    }

    /** Enabled where `lock` leaves from, once a quote nothing blocks is held. */
    get lockDisabled$(): Observable<boolean> {
        return this.quoted$.pipe(
            map(
                ({ node, quote }) =>
                    !LOCKABLE.includes(node) ||
                    quote === undefined ||
                    lockBlocker(quote) !== undefined,
            ),
        );
    }

    /**
     * What the user can do next, in words: what blocks the lock, or the
     * node's message. The flow reads again by itself while Ethereum is down
     * or a read fails, and the pins show the connections.
     */
    get message$(): Observable<string> {
        return this.quoted$.pipe(
            map(({ node, quote }) => {
                const blocker =
                    quote === undefined || !LOCKABLE.includes(node)
                        ? undefined
                        : lockBlocker(quote);
                if (blocker === 'paused' && quote !== undefined)
                    return `${quote.symbol} is paused by its issuer on Ethereum: locks wait for the unpause`;
                if (blocker === 'balance' && quote !== undefined)
                    return `You hold ${tokenAmountText(quote.balance, quote.decimals, quote.symbol)}`;
                if (node === 'current' || node === 'refreshing')
                    return 'Locked for good: the bridge has no unlock path, so the supply retires on Ethereum';
                return MESSAGE[node];
            }),
        );
    }

    /** The lock is sent: its proof and claim show. */
    get claiming$(): Observable<boolean> {
        return this.state$.pipe(map(({ node }) => node === 'locked'));
    }

    get txHash$(): Observable<string> {
        return this.state$.pipe(map((state) => (state.node === 'locked' ? state.data.txHash : '')));
    }

    get claimShown$(): Observable<boolean> {
        return this.claimState$.pipe(
            map(
                (claim) =>
                    claim !== undefined &&
                    (CLAIMABLE.includes(claim.node) || claim.node === 'claiming'),
            ),
        );
    }

    get claimDisabled$(): Observable<boolean> {
        return this.claimState$.pipe(
            map((claim) => claim === undefined || !CLAIMABLE.includes(claim.node)),
        );
    }

    get claimLabel$(): Observable<string> {
        return this.claimState$.pipe(
            map((claim) =>
                claim?.node === 'claiming' ? 'Confirm in your wallet on Tempo…' : 'Claim on Tempo',
            ),
        );
    }

    get done$(): Observable<boolean> {
        return this.claimState$.pipe(
            map((claim) => claim !== undefined && DONE.includes(claim.node)),
        );
    }

    /** Where the claim stands, in words. */
    get claimMessage$(): Observable<string> {
        return this.claimState$.pipe(
            switchMap((claim) =>
                claim === undefined
                    ? NEVER
                    : this.quoted$.pipe(
                          map(({ quote }) => {
                              const net =
                                  quote === undefined
                                      ? ''
                                      : tokenAmountText(quote.net, quote.decimals, quote.symbol);
                              const { recipient } = claim.data.lock;
                              switch (claim.node) {
                                  case 'waitingForProof':
                                      return `Nori proves the lock once Ethereum finalizes it; then ${recipient} claims ${net} on Tempo`;
                                  case 'readingWitness':
                                      return 'Proven: reading the lock’s proof from Ethereum';
                                  case 'claimable':
                                      return `Proven on Tempo: claim ${net} as ${recipient}`;
                                  case 'claiming':
                                      return 'Your wallet switches to Tempo and asks you to confirm the claim';
                                  case 'claimDeclined':
                                      return 'You cancelled the claim in your wallet';
                                  case 'claimFailed':
                                      return claimFailureText(claim.data.error, recipient);
                                  case 'claimed':
                                      return `Claimed on Tempo: everything locked for ${recipient} is minted`;
                                  case 'alreadyClaimed':
                                      return `Already claimed: everything locked for ${recipient} is on Tempo`;
                                  case 'lockReplaced':
                                      return 'The lock was replaced in your wallet before it reached the bridge';
                                  case 'lockDropped':
                                      return 'The lock was dropped before it reached the bridge';
                              }
                          }),
                      ),
            ),
        );
    }

    onAmount(event: Event): void {
        const amount = (event.target as HTMLInputElement).value.trim();
        this.migrate.edit((request) => ({ ...request, amount }));
    }

    onRecipient(event: Event): void {
        const recipient = (event.target as HTMLInputElement).value.trim();
        this.migrate.edit((request) => ({ ...request, recipient }));
    }

    /** The lock button: approves first if the bridge may not take the amount yet, then locks. */
    lock(): void {
        this.migrate.lock.lock();
    }

    claim(): void {
        this.migrate.claim$.pipe(take(1)).subscribe((claim) => claim?.claim());
    }

    another(): void {
        this.migrate.lock.another();
    }
}
