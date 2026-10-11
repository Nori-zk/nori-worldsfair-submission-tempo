import {
    BehaviorSubject,
    debounceTime,
    distinctUntilChanged,
    filter,
    map,
    NEVER,
    type Observable,
    pairwise,
    Subject,
    switchMap,
    take,
    withLatestFrom,
} from 'rxjs';
import { Interface } from 'ethers';
import { NoriTokenBridge__factory } from '@nori-zk/ethereum-tempo-bridge';
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
import { codeChallengeOf } from '@nori-zk/backstop-keeper/migration';
import { LockGraph, type LockState } from './lock.js';
import { type LockRequest, type Quote } from './quote.js';
import { isComplete, lockBlocker, type QuoteAddresses, quote$ } from './quote.impl.js';
import { sendOnChain } from './wallet-send.js';

/** How long the form waits after the last edit before reading. */
const EDIT_SETTLE_MS = 400;

/** The data of the flow's nodes. */
type DataAt<TNode extends LockState['node']> = Extract<LockState, { node: TNode }>['data'];

/** A running wallet transaction machine. */
type WalletTransaction = ReturnType<typeof createWalletTransactionMachine>;

/** The ERC-20's `approve`, and the errors an ERC-20 refuses with. */
const erc20Interface = new Interface([
    'function approve(address spender, uint256 amount) returns (bool)',
]);

/** The token bridge's ABI: what `lockERC20` is encoded with, and what names a refusal. */
const tokenBridgeInterface = NoriTokenBridge__factory.createInterface();

/**
 * The request a state of the flow holds.
 *
 * @param state The flow's state.
 * @returns The amount, recipient and holder, or `undefined` once `closed`.
 */
export const requestOf = (state: LockState): LockRequest | undefined =>
    'amount' in state.data
        ? { amount: state.data.amount, recipient: state.data.recipient, holder: state.data.holder }
        : undefined;

/**
 * The quote a state of the flow holds.
 *
 * @param state The flow's state.
 * @returns The quote, or `undefined` where the node holds none yet.
 */
export const quoteOf = (state: LockState): Quote | undefined =>
    'quote' in state.data ? state.data.quote : undefined;

/**
 * The account a state of the account machine holds.
 *
 * @param state The account machine's state.
 * @returns The account, or `undefined` while none is shared.
 */
const accountOf = (
    state: WalletAccount extends { state$: Observable<infer S> } ? S : never,
): string | undefined => ('account' in state.data ? state.data.account : undefined);

/**
 * The hash of the transaction a wallet transaction machine sent.
 *
 * @param state The wallet transaction machine's state.
 * @returns The hash once sent, else `''`.
 */
const sentHashOf = (state: WalletTransactionState): string =>
    'transactionHash' in state.data ? state.data.transactionHash : '';

/**
 * Why a wallet transaction did not go through before the chain's verdict,
 * or `undefined` while it still may. A wallet on the other chain is not a
 * failure: it is asked to switch, and the transaction is sent once it has.
 *
 * @param state The wallet transaction machine's state.
 * @returns The reason.
 */
const refusalOf = (state: WalletTransactionState): string | undefined => {
    if (state.node === 'refused') return state.data.errorName;
    if (state.node === 'sendFailed') return state.data.error;
    if (state.node === 'reverted' || state.node === 'replaced' || state.node === 'dropped')
        return state.node;
    return undefined;
};

/**
 * The approval the lock needs: the token bridge may take the amount.
 *
 * @param addresses The ERC-20 and the token bridge.
 * @param data The request and its quote.
 * @returns The call.
 */
const approveCall = (
    { token, tokenBridge }: QuoteAddresses,
    { quote }: DataAt<'approving'>,
): TransactionCall => ({
    to: token,
    data: erc20Interface.encodeFunctionData('approve', [tokenBridge, quote.units]),
    value: 0n,
});

/**
 * The lock: `lockERC20` of the amount for the recipient, paying the queue
 * fee quoted.
 *
 * @param addresses The ERC-20 and the token bridge.
 * @param data The request and its quote.
 * @returns The call.
 */
const lockCall = (
    { token, tokenBridge }: QuoteAddresses,
    { recipient, quote }: DataAt<'signing'>,
): TransactionCall => ({
    to: tokenBridge,
    data: tokenBridgeInterface.encodeFunctionData('lockERC20', [
        token,
        quote.units,
        codeChallengeOf(recipient),
    ]),
    value: quote.queueFee,
});

/** The flow's two transactions: the approval, and the lock. */
type TransactionKind = 'approve' | 'lock';

/**
 * Which of the flow's transactions a node follows: the approval while
 * approving, the lock from signing through locked, none elsewhere.
 *
 * @param state The flow's state.
 * @returns The transaction.
 */
const transactionOf = ({ node }: LockState): TransactionKind | undefined =>
    node === 'approving' ? 'approve' : node === 'signing' || node === 'locked' ? 'lock' : undefined;

/**
 * Starts the lock flow at `noAccount`.
 *
 * The quote is the flow's own read (`LockGraph` spreads
 * `readThroughConnectionsOf`), read through Ethereum and again on each new
 * Ethereum block. The flow's own steps gate on two other machines' states,
 * as the ystate README's heater gates on `temperature$`: the wallet's
 * account machine, and the approval's or lock's wallet transaction machine.
 *
 * @param connections The Ethereum and Tempo chains; the approval and the lock go through the wallet.
 * @param account The Ethereum wallet's account machine.
 * @param addresses The ERC-20 migrated and the token bridge.
 * @returns The running flow. Its controls:
 *   - `edit(request)`: replaces the amount and recipient; a complete request is read once edits settle.
 *   - `lock()`: approves first if needed, then signs the lock; again after a decline, a failure or a revert.
 *   - `another()`: reads the same request again for another lock.
 *   - `retry()`: reads again now, while the read has failed.
 *   - `close()`: closes the flow and its transaction.
 */
export function createLockMachine(
    connections: ProofRequestConnections,
    account: WalletAccount,
    addresses: QuoteAddresses,
): LockMachine {
    const edit$ = new Subject<LockRequest>();
    const lock$ = new Subject<void>();
    const another$ = new Subject<void>();
    // The approval's or the lock's transaction while the flow is approving, signing or locked.
    const transaction$ = new BehaviorSubject<
        { kind: TransactionKind; machine: WalletTransaction } | undefined
    >(undefined);
    /** The states of the flow's transaction of one kind: each node gates only on its own. */
    const transactionState$ = (kind: TransactionKind): Observable<WalletTransactionState> =>
        transaction$.pipe(
            switchMap((transaction) =>
                transaction?.kind === kind ? transaction.machine.state$ : NEVER,
            ),
        );
    const sharedAccount$ = account.state$.pipe(
        map(accountOf),
        filter((shared): shared is string => shared !== undefined),
    );
    // A change of account after the node was entered: the one before and the one now.
    const accountChange$ = sharedAccount$.pipe(distinctUntilChanged(), pairwise());
    const newBlocks = createChainChangesMachine(connections.ethereum);

    const flow = startReadThroughConnectionsMachine(LockGraph, {
        connections,
        read: (clients, previous) =>
            clients
                .ethereum((provider) => quote$(provider, addresses, previous))
                .pipe(
                    map((quote) => ({
                        amount: previous.amount,
                        recipient: previous.recipient,
                        holder: previous.holder,
                        quote,
                    })),
                ),
        refreshOn: () => changesOf$(newBlocks),
        needs: ['ethereum'],
        owns: [newBlocks],
        start: { node: 'noAccount', data: { amount: '', recipient: '', holder: '' } },
        ownTransitions: (_read$, state$) => {
            /** The holder follows the account, and the recipient with it while they were the same. */
            const followed$ = accountChange$.pipe(
                withLatestFrom(state$.pipe(map(requestOf))),
                filter(
                    (change): change is [[string, string], LockRequest] => change[1] !== undefined,
                ),
                map(([[before, now], request]) => ({
                    amount: request.amount,
                    holder: now,
                    recipient:
                        request.recipient.toLowerCase() === before.toLowerCase()
                            ? now
                            : request.recipient,
                })),
            );
            /** A lock request, with the quote held: gated on the issuer's pause and the balance. */
            const lockable$ = lock$.pipe(
                withLatestFrom(state$),
                map(([, state]) => quoteOf(state)),
                filter(
                    (quote): quote is Quote =>
                        quote !== undefined && lockBlocker(quote) === undefined,
                ),
            );
            const toLoading = (request: LockRequest): DataAt<'loading'> => ({
                ...request,
                quote: undefined,
                failedReads: 0,
            });
            return {
                accountShared: {
                    $: () => sharedAccount$.pipe(take(1)),
                    next: (holder: string): DataAt<'editing'> => ({
                        amount: '',
                        recipient: holder,
                        holder,
                    }),
                },
                accountChanged: {
                    $: () => followed$,
                    next: toLoading,
                },
                accountChangedWhileEditing: {
                    $: () => followed$,
                    next: (request: LockRequest): DataAt<'editing'> => request,
                },
                editIncomplete: {
                    $: () => edit$.pipe(filter((request) => !isComplete(request))),
                    next: (request: LockRequest): DataAt<'editing'> => request,
                },
                editComplete: {
                    $: () => edit$.pipe(debounceTime(EDIT_SETTLE_MS), filter(isComplete)),
                    next: toLoading,
                },
                approve: {
                    $: () => lockable$.pipe(filter((quote) => quote.allowance < quote.units)),
                    next: (
                        quote: Quote,
                        _dest: unknown,
                        source: LockRequest,
                    ): DataAt<'approving'> => ({
                        amount: source.amount,
                        recipient: source.recipient,
                        holder: source.holder,
                        quote,
                    }),
                },
                lock: {
                    $: () => lockable$.pipe(filter((quote) => quote.allowance >= quote.units)),
                    next: (
                        quote: Quote,
                        _dest: unknown,
                        source: LockRequest,
                    ): DataAt<'signing'> => ({
                        amount: source.amount,
                        recipient: source.recipient,
                        holder: source.holder,
                        quote,
                    }),
                },
                approved: {
                    $: () =>
                        transactionState$('approve').pipe(
                            filter((state) => state.node === 'confirmed'),
                            take(1),
                        ),
                    next: (
                        _confirmed: unknown,
                        _dest: unknown,
                        source: DataAt<'approving'>,
                    ): DataAt<'signing'> => ({
                        ...source,
                        quote: { ...source.quote, allowance: source.quote.units },
                    }),
                },
                approvalDeclined: {
                    $: () =>
                        transactionState$('approve').pipe(
                            filter(({ node }) => node === 'declined'),
                            take(1),
                        ),
                    next: (
                        _declined: unknown,
                        _dest: unknown,
                        source: DataAt<'approving'>,
                    ): DataAt<'declined'> => source,
                },
                approvalRefused: {
                    $: () =>
                        transactionState$('approve').pipe(
                            map(refusalOf),
                            filter((error): error is string => error !== undefined),
                            take(1),
                        ),
                    next: (
                        error: string,
                        _dest: unknown,
                        source: DataAt<'approving'>,
                    ): DataAt<'sendFailed'> => ({
                        ...source,
                        error,
                    }),
                },
                userDeclined: {
                    $: () =>
                        transactionState$('lock').pipe(
                            filter(({ node }) => node === 'declined'),
                            take(1),
                        ),
                    next: (
                        _declined: unknown,
                        _dest: unknown,
                        source: DataAt<'signing'>,
                    ): DataAt<'declined'> => source,
                },
                sendRefused: {
                    $: () =>
                        transactionState$('lock').pipe(
                            map(refusalOf),
                            filter((error): error is string => error !== undefined),
                            take(1),
                        ),
                    next: (
                        error: string,
                        _dest: unknown,
                        source: DataAt<'signing'>,
                    ): DataAt<'sendFailed'> => ({
                        ...source,
                        error,
                    }),
                },
                sent: {
                    $: () =>
                        transactionState$('lock').pipe(
                            map(sentHashOf),
                            filter((hash) => hash !== ''),
                            take(1),
                        ),
                    next: (
                        txHash: string,
                        _dest: unknown,
                        source: DataAt<'signing'>,
                    ): DataAt<'locked'> => ({
                        ...source,
                        txHash,
                    }),
                },
                transactionReverted: {
                    $: () =>
                        transactionState$('lock').pipe(
                            filter((state) => state.node === 'reverted'),
                            take(1),
                        ),
                    next: (
                        _reverted: unknown,
                        _dest: unknown,
                        source: DataAt<'locked'>,
                    ): DataAt<'reverted'> => source,
                },
                another: {
                    $: () => another$,
                    next: (
                        _another: unknown,
                        _dest: unknown,
                        source: LockRequest,
                    ): DataAt<'loading'> =>
                        toLoading({
                            amount: source.amount,
                            recipient: source.recipient,
                            holder: source.holder,
                        }),
                },
            };
        },
    });

    // The approval is sent on entering `approving`, and followed until it is
    // confirmed; the lock is sent on entering `signing` and followed through
    // `locked`, for a revert. Leaving them closes it. Pulsed from outside the
    // flow off its state, as the ystate studio's traffic form pulses the
    // pedestrian's signals off the light's.
    flow.state$
        .pipe(distinctUntilChanged((before, now) => transactionOf(before) === transactionOf(now)))
        .subscribe((state) => {
            transaction$.value?.machine.close();
            if (state.node !== 'approving' && state.node !== 'signing') {
                transaction$.next(undefined);
                return;
            }
            const transaction =
                state.node === 'approving'
                    ? {
                          kind: 'approve' as const,
                          machine: createWalletTransactionMachine(
                              connections,
                              'ethereum',
                              approveCall(addresses, state.data),
                              { errors: erc20Interface },
                          ),
                      }
                    : {
                          kind: 'lock' as const,
                          machine: createWalletTransactionMachine(
                              connections,
                              'ethereum',
                              lockCall(addresses, state.data),
                              { errors: tokenBridgeInterface },
                          ),
                      };
            transaction$.next(transaction);
        });
    // Sent each time it is ready: at once, and again once the wallet, asked to switch, is on Ethereum.
    const sending = sendOnChain(
        connections,
        'ethereum',
        transaction$.pipe(map((transaction) => transaction?.machine)),
    );

    const closeFlow = flow.close;
    return Object.assign(flow, {
        edit: (request: LockRequest) => edit$.next(request),
        lock: () => lock$.next(),
        another: () => another$.next(),
        close: () => {
            closeFlow();
            sending.unsubscribe();
            transaction$.value?.machine.close();
            transaction$.next(undefined);
        },
    });
}

/** The running lock flow, with its controls. */
export type LockMachine = ReturnType<
    typeof startReadThroughConnectionsMachine<
        typeof LockGraph.nodes,
        typeof LockGraph.edges,
        LockRequest & { quote: Quote }
    >
> & {
    edit: (request: LockRequest) => void;
    lock: () => void;
    another: () => void;
};
