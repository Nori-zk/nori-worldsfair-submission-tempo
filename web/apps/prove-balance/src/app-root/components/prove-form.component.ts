import { Component, Inject, RxElement } from '@yaw-rx/core';
import { RxIf } from '@yaw-rx/core/directives/rx-if';
import { combineLatest, map, type Observable } from 'rxjs';
import { TokenListService, tokenAmountText } from '@nori-zk/tempo-web-ui';
import { TOKEN_CHOSEN } from './prove-form/token-option.component.js';
import './prove-form/token-select.component.js';
import { type BalanceRequest, previewOf, requestOf } from '../machines/prove-balance.impl.js';
import type { ProveBalanceState } from '../machines/prove-balance.js';
import { ProveBalanceService } from '../services/prove-balance.service.js';
import styles from './prove-form.component.css';

/** The nodes of the flow; a node's own name. */
type Node = ProveBalanceState['node'];

/** The nodes where the balance is being read for the request the form holds, before any is held. */
const FIRST_READ: Node[] = ['loading', 'waitingForConnectionWhileLoading'];

/** The nodes `prove` leaves from: a balance is held, or a send can be tried again. */
const PROVABLE: Node[] = ['current', 'refreshing', 'declined', 'sendFailed', 'reverted'];

/** What the user can do next, in words, for each node of the flow. */
const MESSAGE: Record<Node, string> = {
    noAccount: '',
    editing: 'Enter a token and an Ethereum address',
    loading: '',
    current: '',
    refreshing: '',
    waitingForConnectionWhileLoading: '',
    waitingForConnectionWhileRefreshing: '',
    failedWhileLoading: 'No balance could be read for this token and address yet · trying again',
    failedWhileRefreshing: 'The balance could not be read again yet · trying again',
    closed: '',
    signing: '',
    declined: 'You cancelled the transaction in your wallet',
    sendFailed: 'The transaction did not go through · send it again or change the request',
    proving: '',
    reverted: 'The transaction did not go through · send it again or change the request',
};

/**
 * The form for proving a balance: the token and the address, the balance and
 * fee read as soon as both are valid, the snapshot sent from the wallet, and
 * the proof followed to Tempo. Each part shows for the flow's node.
 */
@Component({
    selector: 'prove-form',
    directives: [RxIf],
    template: `
        <p class="message" rx-if="disconnected">
            Connect your Ethereum wallet above to prove a balance.
        </p>
        <div rx-if="editable">
            <div class="label">Token</div>
            <token-select [asset]="asset" [disabled]="locked"></token-select>
            <div rx-if="isOther">
                <label
                    >Token address
                    <input
                        [value]="tokenAddress"
                        [disabled]="locked"
                        placeholder="0x…"
                        oninput="onTokenAddress($event)"
                    />
                </label>
            </div>
            <label
                >Address
                <input
                    [value]="holder"
                    [disabled]="locked"
                    placeholder="0x…"
                    oninput="onHolder($event)"
                />
            </label>
        </div>
        <div rx-if="editable">
            <div class="summary">
                <div class="stat">
                    <span class="stat-label">Balance</span>
                    <span class="stat-value"
                        ><span rx-if="reading"><span class="spinner"></span></span
                        >{{ balance }}</span
                    >
                </div>
                <div class="stat">
                    <span class="stat-label">Fee</span>
                    <span class="stat-value">{{ fee }}</span>
                </div>
            </div>
            <div class="actions" rx-if="actionShown">
                <button [disabled]="actionDisabled" onclick="act">{{ actionLabel }}</button>
            </div>
            <p class="message">{{ message }}</p>
        </div>
        <div rx-if="proving">
            <proof-progress [txHash]="txHash"></proof-progress>
            <div class="actions">
                <button class="secondary" onclick="another">Prove another</button>
            </div>
        </div>
    `,
    styles,
})
export class ProveForm extends RxElement {
    @Inject(TokenListService) private readonly tokenList!: TokenListService;
    @Inject(ProveBalanceService) private readonly proveBalance!: ProveBalanceService;

    private get state$(): Observable<ProveBalanceState> {
        return this.proveBalance.state$;
    }

    /**
     * The request the flow holds, or an empty one once it is closed.
     *
     * @returns The asset and holder.
     */
    private get request$(): Observable<BalanceRequest> {
        return this.state$.pipe(map((state) => requestOf(state) ?? { asset: '', holder: '' }));
    }

    override onInit(): void {
        this.addEventListener(TOKEN_CHOSEN, this.onTokenChosen);
    }

    get disconnected$(): Observable<boolean> {
        return this.state$.pipe(map(({ node }) => node === 'noAccount'));
    }

    get editable$(): Observable<boolean> {
        return this.state$.pipe(map(({ node }) => node !== 'noAccount' && node !== 'closed'));
    }

    /** Whether the form is fixed: the wallet is asked to sign, or the proof is under way. */
    get locked$(): Observable<boolean> {
        return this.state$.pipe(map(({ node }) => node === 'signing' || node === 'proving'));
    }

    /** The one button stays in place until the proof is under way. */
    get actionShown$(): Observable<boolean> {
        return this.state$.pipe(map(({ node }) => node !== 'proving'));
    }

    get actionLabel$(): Observable<string> {
        return this.state$.pipe(
            map(({ node }) => (node === 'signing' ? 'Confirm in your wallet…' : 'Prove on Tempo')),
        );
    }

    /** Enabled where `prove` leaves from, once a balance is held. */
    get actionDisabled$(): Observable<boolean> {
        return this.state$.pipe(
            map((state) => !PROVABLE.includes(state.node) || previewOf(state) === undefined),
        );
    }

    get asset$(): Observable<string> {
        return this.request$.pipe(map(({ asset }) => asset));
    }

    /** Whether the asset is a token the list does not have: its address is typed in. */
    get isOther$(): Observable<boolean> {
        return combineLatest([this.request$, this.tokenList.tokens$]).pipe(
            map(
                ([{ asset }, tokens]) =>
                    asset !== 'eth' &&
                    !tokens.some((token) => token.address.toLowerCase() === asset.toLowerCase()),
            ),
        );
    }

    get tokenAddress$(): Observable<string> {
        return this.request$.pipe(map(({ asset }) => (asset === 'eth' ? '' : asset)));
    }

    get holder$(): Observable<string> {
        return this.request$.pipe(map(({ holder }) => holder));
    }

    /** Whether the balance is on its way for the request the form holds. */
    get reading$(): Observable<boolean> {
        return this.state$.pipe(map(({ node }) => FIRST_READ.includes(node)));
    }

    /** The balance read, nothing while it is on its way, or "—" before there is one. */
    get balance$(): Observable<string> {
        return this.state$.pipe(
            map((state) => {
                const preview = previewOf(state);
                if (preview !== undefined)
                    return tokenAmountText(preview.balance, preview.decimals, preview.symbol);
                return FIRST_READ.includes(state.node) ? '' : '—';
            }),
        );
    }

    /** The snapshot fee read, or "—" before there is one. */
    get fee$(): Observable<string> {
        return this.state$.pipe(
            map((state) => {
                const preview = previewOf(state);
                return preview === undefined ? '—' : tokenAmountText(preview.fee, 18, 'ETH');
            }),
        );
    }

    /**
     * What the user can do next, in words, for the node the flow is at. The
     * flow reads again by itself while Ethereum is down or a read fails, and
     * the pins show the connections.
     */
    get message$(): Observable<string> {
        return this.state$.pipe(map(({ node }) => MESSAGE[node]));
    }

    get proving$(): Observable<boolean> {
        return this.state$.pipe(map(({ node }) => node === 'proving'));
    }

    get txHash$(): Observable<string> {
        return this.state$.pipe(
            map((state) => (state.node === 'proving' ? state.data.txHash : '')),
        );
    }

    onTokenAddress(event: Event): void {
        const asset = (event.target as HTMLInputElement).value.trim();
        this.proveBalance.edit((request) => ({ ...request, asset }));
    }

    /**
     * A token picked in the dropdown: ETH or a listed token's address, or an
     * empty address to type in for "Other token…".
     *
     * @param event The option's `token-chosen` event.
     * @returns {void}
     */
    private readonly onTokenChosen = (event: Event): void => {
        const chosen = (event as CustomEvent<string>).detail;
        this.proveBalance.edit((request) => ({
            ...request,
            asset: chosen === 'other' ? '' : chosen,
        }));
    };

    onHolder(event: Event): void {
        const holder = (event.target as HTMLInputElement).value.trim();
        this.proveBalance.edit((request) => ({ ...request, holder }));
    }

    /** The one button: proves the balance read. */
    act(): void {
        this.proveBalance.machine.prove();
    }

    another(): void {
        this.proveBalance.machine.another();
    }

    override onDestroy(): void {
        this.removeEventListener(TOKEN_CHOSEN, this.onTokenChosen);
    }
}
