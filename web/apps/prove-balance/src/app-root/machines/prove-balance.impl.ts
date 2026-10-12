import {
    BehaviorSubject,
    distinctUntilChanged,
    filter,
    map,
    NEVER,
    type Observable,
    pairwise,
    Subject,
    switchMap,
    take,
    timer,
    withLatestFrom,
} from 'rxjs';
import { isAddress } from 'ethers';
import {
    changesOf$,
    createChainChangesMachine,
    createWalletTransactionMachine,
    type ProofRequestConnections,
    startReadThroughConnectionsMachine,
    type TransactionCall,
    type WalletAccount,
    type WalletTransactionState,
} from '@nori-zk/nori-bridge-tempo-sdk';
import { NoriSnapshot__factory } from '@nori-zk/ethereum-snapshot';
import { type Preview } from './preview.js';
import { balanceQuery, type BalanceRequest, preview$ } from './preview.impl.js';
import { ProveBalanceGraph, type ProveBalanceState } from './prove-balance.js';

export type { BalanceRequest } from './preview.impl.js';

/**
 * How long a read waits before it starts, so typing reads once: each edit
 * re-enters `loading` at once (the proof disabled) and restarts the wait.
 */
const EDIT_SETTLE_MS = 400;

/** The data of the flow's nodes. */
type DataAt<TNode extends ProveBalanceState['node']> = Extract<ProveBalanceState, { node: TNode }>['data'];

/** A running wallet transaction machine. */
type WalletTransaction = ReturnType<typeof createWalletTransactionMachine>;

/**
 * Whether a request can be read: the asset is `eth` or an address, and the
 * holder is an address.
 *
 * @param request The asset and holder.
 * @returns Whether both are valid.
 */
const isComplete = ({ asset, holder }: BalanceRequest): boolean =>
    (asset === 'eth' || isAddress(asset)) && isAddress(holder);

/**
 * The request a state of the flow holds.
 *
 * @param state The flow's state.
 * @returns The asset and holder, or `undefined` once `closed`.
 */
export const requestOf = (state: ProveBalanceState): BalanceRequest | undefined =>
    'asset' in state.data ? { asset: state.data.asset, holder: state.data.holder } : undefined;

/**
 * The balance and fee a state of the flow holds.
 *
 * @param state The flow's state.
 * @returns The preview, or `undefined` where the node holds none yet.
 */
export const previewOf = (state: ProveBalanceState): Preview | undefined =>
    'preview' in state.data ? state.data.preview : undefined;

/**
 * The account a state of the account machine holds.
 *
 * @param state The account machine's state.
 * @returns The account, or `undefined` while none is shared.
 */
const accountOf = (state: WalletAccount extends { state$: Observable<infer S> } ? S : never): string | undefined =>
    'account' in state.data ? state.data.account : undefined;

/**
 * The hash of the transaction a wallet transaction machine sent.
 *
 * @param state The wallet transaction machine's state.
 * @returns The hash once sent, else `''`.
 */
const sentHashOf = (state: WalletTransactionState): string =>
    'transactionHash' in state.data ? state.data.transactionHash : '';

/** `NoriSnapshot`'s ABI: what the snapshot call is encoded with, and what names a refusal. */
const noriSnapshotInterface = NoriSnapshot__factory.createInterface();

/**
 * The one `NoriSnapshot.snapshot` call that proves a request's balance,
 * paying the fee previewed.
 *
 * @param snapshotAddress The `NoriSnapshot` address.
 * @param data The request and its preview.
 * @returns The call: the contract, its data and the fee.
 */
const snapshotCall = (snapshotAddress: string, { asset, holder, preview }: DataAt<'signing'>): TransactionCall => ({
    to: snapshotAddress,
    data: noriSnapshotInterface.encodeFunctionData('snapshot', [[balanceQuery({ asset, holder })]]),
    value: preview.fee,
});

/**
 * Starts the prove balance flow at `noAccount`.
 *
 * The balance and fee are the flow's own read (`ProveBalanceGraph` spreads
 * `readThroughConnectionsOf`), read through the wallet and again on each new
 * Ethereum block. The flow's own steps gate on two other machines' states,
 * as the ystate README's heater gates on `temperature$`: the wallet's
 * account machine, and the snapshot's wallet transaction machine.
 *
 * @param connections The Ethereum and Tempo chains; reads and the snapshot go through the wallet.
 * @param account The wallet's account machine.
 * @param snapshotAddress The `NoriSnapshot` address.
 * @returns The running flow. Its controls:
 *   - `edit(request)`: replaces the asset and holder; a complete request is read once edits settle.
 *   - `prove()`: signs the snapshot, or signs it again after a decline, a failure or a revert.
 *   - `another()`: reads the same request again for another proof.
 *   - `retry()`: reads again now, while the read has failed.
 *   - `close()`: closes the flow and the snapshot's transaction.
 */
export function createProveBalanceMachine(
    connections: ProofRequestConnections,
    account: WalletAccount,
    snapshotAddress: string,
): ProveBalanceMachine {
    const edit$ = new Subject<BalanceRequest>();
    const prove$ = new Subject<void>();
    const another$ = new Subject<void>();
    // The snapshot's transaction while the flow is signing or proving.
    const transaction$ = new BehaviorSubject<WalletTransaction | undefined>(undefined);
    const transactionState$: Observable<WalletTransactionState> = transaction$.pipe(
        switchMap((transaction) => (transaction === undefined ? NEVER : transaction.state$)),
    );
    const sharedAccount$ = account.state$.pipe(
        map(accountOf),
        filter((shared): shared is string => shared !== undefined),
    );
    // A change of account after the node was entered: the one before and the one now.
    const accountChange$ = sharedAccount$.pipe(distinctUntilChanged(), pairwise());
    const newBlocks = createChainChangesMachine(connections.ethereum);

    const flow = startReadThroughConnectionsMachine(ProveBalanceGraph, {
        connections,
        read: (clients, previous) =>
            timer(EDIT_SETTLE_MS).pipe(
                switchMap(() => clients.transport((provider) => preview$(provider, snapshotAddress, previous))),
                map((preview) => ({ asset: previous.asset, holder: previous.holder, preview })),
            ),
        refreshOn: () => changesOf$(newBlocks),
        needs: ['ethereum.wallet'],
        owns: [newBlocks],
        start: { node: 'noAccount', data: { asset: 'eth', holder: '' } },
        ownTransitions: (_read$, state$) => {
            /** The holder follows the account while it is the account before the change. */
            const followed$ = accountChange$.pipe(
                withLatestFrom(state$.pipe(map(requestOf))),
                filter(
                    (change): change is [[string, string], BalanceRequest] =>
                        change[1] !== undefined && change[1].holder === change[0][0],
                ),
                map(([[, now], { asset }]) => ({ asset, holder: now })),
            );
            return {
                accountShared: {
                    $: () => sharedAccount$.pipe(take(1)),
                    next: (holder: string): DataAt<'loading'> => ({
                        asset: 'eth',
                        holder,
                        preview: undefined,
                        failedReads: 0,
                    }),
                },
                accountChanged: {
                    $: () => followed$,
                    next: (request: BalanceRequest): DataAt<'loading'> => ({
                        ...request,
                        preview: undefined,
                        failedReads: 0,
                    }),
                },
                accountChangedWhileEditing: {
                    $: () => followed$,
                    next: (request: BalanceRequest): DataAt<'editing'> => request,
                },
                editIncomplete: {
                    $: () => edit$.pipe(filter((request) => !isComplete(request))),
                    next: (request: BalanceRequest): DataAt<'editing'> => request,
                },
                editComplete: {
                    $: () => edit$.pipe(filter(isComplete)),
                    next: (request: BalanceRequest): DataAt<'loading'> => ({
                        ...request,
                        preview: undefined,
                        failedReads: 0,
                    }),
                },
                prove: {
                    $: () =>
                        prove$.pipe(
                            withLatestFrom(state$),
                            map(([, state]) => previewOf(state)),
                            filter((preview): preview is Preview => preview !== undefined),
                        ),
                    next: (preview: Preview, _dest: unknown, { asset, holder }: BalanceRequest): DataAt<'signing'> => ({
                        asset,
                        holder,
                        preview,
                    }),
                },
                userDeclined: {
                    $: () => transactionState$.pipe(filter(({ node }) => node === 'declined'), take(1)),
                    next: (_declined: unknown, _dest: unknown, source: DataAt<'signing'>): DataAt<'declined'> => source,
                },
                sendRefused: {
                    $: () =>
                        transactionState$.pipe(
                            map((state) => {
                                if (state.node === 'refused') return state.data.errorName;
                                if (state.node === 'sendFailed') return state.data.error;
                                if (state.node === 'notReadyToSend')
                                    return `Waiting on ${state.data.waitingOn.join(', ')}`;
                                return undefined;
                            }),
                            filter((error): error is string => error !== undefined),
                            take(1),
                        ),
                    next: (error: string, _dest: unknown, source: DataAt<'signing'>): DataAt<'sendFailed'> => ({
                        ...source,
                        error,
                    }),
                },
                sent: {
                    $: () =>
                        transactionState$.pipe(
                            map(sentHashOf),
                            filter((hash) => hash !== ''),
                            take(1),
                        ),
                    next: (txHash: string, _dest: unknown, source: DataAt<'signing'>): DataAt<'proving'> => ({
                        ...source,
                        txHash,
                    }),
                },
                transactionReverted: {
                    $: () =>
                        transactionState$.pipe(
                            filter((state) => state.node === 'reverted'),
                            take(1),
                        ),
                    next: (_reverted: unknown, _dest: unknown, source: DataAt<'proving'>): DataAt<'reverted'> =>
                        source,
                },
                another: {
                    $: () => another$,
                    next: (_another: unknown, _dest: unknown, { asset, holder }: BalanceRequest): DataAt<'loading'> => ({
                        asset,
                        holder,
                        preview: undefined,
                        failedReads: 0,
                    }),
                },
            };
        },
    });

    // The snapshot is sent on entering `signing` and followed through
    // `proving`; leaving both closes it. Pulsed from outside the flow off its
    // state, as the ystate studio's traffic form pulses the pedestrian's
    // signals off the light's.
    flow.state$
        .pipe(
            map((state) => (state.node === 'signing' || state.node === 'proving' ? state : undefined)),
            distinctUntilChanged((before, now) => (before === undefined) === (now === undefined)),
        )
        .subscribe((state) => {
            transaction$.value?.close();
            if (state?.node !== 'signing') {
                transaction$.next(undefined);
                return;
            }
            const transaction = createWalletTransactionMachine(
                connections,
                'ethereum',
                snapshotCall(snapshotAddress, state.data),
                { errors: noriSnapshotInterface },
            );
            transaction$.next(transaction);
            transaction.send();
        });

    const closeFlow = flow.close;
    return Object.assign(flow, {
        edit: (request: BalanceRequest) => edit$.next(request),
        prove: () => prove$.next(),
        another: () => another$.next(),
        close: () => {
            closeFlow();
            transaction$.value?.close();
            transaction$.next(undefined);
        },
    });
}

/** The running prove balance flow, with its controls. */
export type ProveBalanceMachine = ReturnType<
    typeof startReadThroughConnectionsMachine<
        typeof ProveBalanceGraph.nodes,
        typeof ProveBalanceGraph.edges,
        BalanceRequest & { preview: Preview }
    >
> & {
    edit: (request: BalanceRequest) => void;
    prove: () => void;
    another: () => void;
};
