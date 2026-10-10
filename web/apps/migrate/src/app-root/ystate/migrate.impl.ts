import {
    catchError,
    debounceTime,
    defer,
    EMPTY,
    filter,
    firstValueFrom,
    from,
    map,
    NEVER,
    type Observable,
    of,
    ReplaySubject,
    share,
    Subject,
    switchMap,
    take,
    timer,
} from 'rxjs';
import { Contract, isAddress, isError, parseUnits, sha256, type TransactionReceipt } from 'ethers';
import {
    bothReady$,
    ConnectionNotReadyError,
    type ConnectionName,
    type Connections,
    type EthereumProvider,
    type EthereumWalletState,
    forCalls,
    getVerifiedRequestWitness,
    mintERC20,
    type ProofRequestStateNodeUnion,
    waitingOnChanged$,
} from '@nori-zk/nori-bridge-tempo-sdk';
import { dataOnEntry$, type StartedMachine, stateOf$ } from '@nori-zk/nori-bridge-tempo-sdk/utils';
import { NoriTokenBridge__factory } from '@nori-zk/ethereum-tempo-bridge';
import { NoriTempoTokenBridge__factory } from '@nori-zk/tempo-token-bridge';
import { MigrateGraph, type MigrateState } from './migrate.js';

/** How long the form waits after the last edit before reading. */
const EDIT_SETTLE_MS = 400;

/** The wait before reading again after the first failed read; it doubles with each one after it. */
const RETRY_INITIAL_MS = 1000;
/** The longest wait between reads after failures. */
const RETRY_MAX_MS = 30_000;

/** A TIP-20 has 6 decimals, so an amount has at most 6. */
const AMOUNT = /^(?:\d+\.?\d{0,6}|\.\d{1,6})$/;

/** The ERC-20 calls the migration makes. */
const ERC20_ABI = [
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function paused() view returns (bool)',
    'function approve(address spender, uint256 amount) returns (bool)',
];

/** The amount, recipient and owner the form holds. */
export interface MigrateRequest {
    /** The amount, in the token's units, as typed. */
    amount: string;
    /** The Tempo address the TIP-20 is minted to. */
    recipient: string;
    /** The wallet's Ethereum account. */
    owner: string;
}

/** The contracts the migration goes through. */
export interface MigrateAddresses {
    /** The Ethereum ERC-20. */
    ethToken: string;
    /** nori-tempo-sdk's `NoriTokenBridge` on Ethereum. */
    tokenBridge: string;
    /** The `NoriProofRequestQueue` it enqueues on. */
    proofQueue: string;
    /** The `NoriTempoTokenBridge` on Tempo. */
    tempoBridge: string;
}

/** What reading a request found. */
interface Quote {
    symbol: string;
    decimals: number;
    units: bigint;
    balance: bigint;
    allowance: bigint;
    paused: boolean;
    queueFee: bigint;
    fee: bigint;
    net: bigint;
}

/** How reading a request ended. */
type ReadOutcome =
    | { outcome: 'succeeded'; value: Quote }
    | { outcome: 'connectionLost'; waitingOn: ConnectionName[] }
    | { outcome: 'failed'; error: string };

/** How sending the lock ended. */
type SendOutcome =
    | { outcome: 'signed'; txHash: string }
    | { outcome: 'declined' }
    | { outcome: 'failed'; error: string };

/** How sending the claim ended. */
type ClaimOutcome =
    | { outcome: 'claimed'; claimTxHash: string }
    | { outcome: 'declined'; error: string }
    | { outcome: 'failed'; error: string };

/** The proof request machine's states for a lock, from the app's proof follower. */
export type FollowLock = (txHash: string) => Observable<ProofRequestStateNodeUnion>;

/**
 * Whether a request can be read: an amount above zero with at most 6
 * decimals, and Ethereum and Tempo addresses.
 *
 * @param request The amount, recipient and owner.
 * @returns Whether all are valid.
 */
const isComplete = ({ amount, recipient, owner }: MigrateRequest): boolean =>
    AMOUNT.test(amount) && Number(amount) > 0 && isAddress(recipient) && isAddress(owner);

/**
 * The message of an error, or its string.
 *
 * @param error The error.
 * @returns The message.
 */
const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

/**
 * Reads the token, the owner's balance and allowance, and the bridge's quote.
 *
 * @param provider The Ethereum provider reads go through.
 * @param addresses The token and the bridge.
 * @param request The amount and owner.
 * @returns The quote.
 */
async function readQuote(
    provider: EthereumProvider,
    addresses: MigrateAddresses,
    request: MigrateRequest,
): Promise<Quote> {
    const token = new Contract(addresses.ethToken, ERC20_ABI, provider);
    const [symbol, decimals, balance, allowance, paused] = await Promise.all([
        token.getFunction('symbol')() as Promise<string>,
        token.getFunction('decimals')() as Promise<bigint>,
        token.getFunction('balanceOf')(request.owner) as Promise<bigint>,
        token.getFunction('allowance')(request.owner, addresses.tokenBridge) as Promise<bigint>,
        token.getFunction('paused')() as Promise<boolean>,
    ]);
    const units = parseUnits(request.amount, decimals);
    const bridge = NoriTokenBridge__factory.connect(addresses.tokenBridge, provider);
    const [queueFee, fee, net] = await bridge.previewLockERC20(addresses.ethToken, units);
    return {
        symbol,
        decimals: Number(decimals),
        units,
        balance,
        allowance,
        paused,
        queueFee,
        fee,
        net,
    };
}

/**
 * Reads the quote through Ethereum's calls order. Nothing in it able to
 * serve the read is a lost connection, naming the chains; any other failure
 * is the read's own.
 *
 * @param ethereum The Ethereum chain.
 * @param addresses The token and the bridge.
 * @param request The amount and owner.
 * @returns How the read ended, once.
 */
function readQuote$(
    ethereum: Connections['ethereum'],
    addresses: MigrateAddresses,
    request: MigrateRequest,
): Observable<ReadOutcome> {
    return defer(async () => forCalls(ethereum, readQuote, addresses, request)).pipe(
        map((value): ReadOutcome => ({ outcome: 'succeeded', value })),
        catchError((error: unknown) =>
            of<ReadOutcome>(
                error instanceof ConnectionNotReadyError
                    ? {
                          outcome: 'connectionLost',
                          waitingOn: [
                              ...new Set(
                                  error.notReady.map(
                                      ({ transport }) => transport.split('.')[0] as ConnectionName,
                                  ),
                              ),
                          ],
                      }
                    : { outcome: 'failed', error: messageOf(error) },
            ),
        ),
    );
}

/** A browser wallet's transport, on Ethereum or on Tempo: its machine, and its controls. */
type Wallet = Connections['ethereum']['wallet'] | Connections['tempo']['wallet'];

/**
 * Asks the wallet onto its chain (Ethereum for the lock, Tempo for the
 * claim), then waits until it is there or the user declines to switch.
 *
 * @param wallet The wallet, on the chain it expects.
 * @returns `ready` once it is on that chain, or `declined`.
 */
function walletOnChain$(wallet: Wallet): Observable<'ready' | 'declined'> {
    return defer(() => {
        wallet.switchToExpectedChain();
        return wallet.connection?.state$ ?? EMPTY;
    }).pipe(
        filter(
            (state: EthereumWalletState) =>
                state.node === 'ready' || state.node === 'switchDeclined',
        ),
        take(1),
        map((state) => (state.node === 'ready' ? 'ready' : 'declined')),
    );
}

/**
 * Locks the amount for the recipient: approves the bridge first when the
 * allowance falls short, then `NoriTokenBridge.lockERC20` with the queue fee,
 * both signed in the user's wallet on Ethereum.
 *
 * @param wallet The user's wallet on Ethereum.
 * @param addresses The token and the bridge.
 * @param request The amount, recipient and quote.
 * @returns How the send ended.
 */
function sendLock$(
    wallet: Wallet,
    addresses: MigrateAddresses,
    request: MigrateRequest & Quote,
): Observable<SendOutcome> {
    return from(
        (async (): Promise<SendOutcome> => {
            if ((await firstValueFrom(walletOnChain$(wallet))) === 'declined')
                return { outcome: 'declined' };
            const signer = await (await wallet.ready()).getSigner();
            if (request.allowance < request.units) {
                const token = new Contract(addresses.ethToken, ERC20_ABI, signer);
                const approval = (await token.getFunction('approve')(
                    addresses.tokenBridge,
                    request.units,
                )) as { wait: () => Promise<unknown> };
                await approval.wait();
            }
            const bridge = NoriTokenBridge__factory.connect(addresses.tokenBridge, signer);
            const lock = await bridge.lockERC20(
                addresses.ethToken,
                request.units,
                BigInt(sha256(request.recipient)),
                { value: request.queueFee },
            );
            return { outcome: 'signed', txHash: lock.hash };
        })(),
    ).pipe(
        catchError((error: unknown) =>
            of<SendOutcome>(
                isError(error, 'ACTION_REJECTED')
                    ? { outcome: 'declined' }
                    : { outcome: 'failed', error: messageOf(error) },
            ),
        ),
    );
}

/**
 * Claims the proven lock: its witness from Ethereum's logs, then
 * `NoriTempoTokenBridge.mintERC20`, signed in the user's wallet on Tempo by
 * the recipient. A lock that a later claim already covered is claimed.
 *
 * @param connections The chains; the claim signs through Tempo's wallet.
 * @param addresses The queue and the Tempo bridge.
 * @param proofAvailable The lock's proof request, covered by a committed batch.
 * @returns How the claim ended.
 */
function sendClaim$(
    connections: Connections,
    addresses: MigrateAddresses,
    proofAvailable: (typeof MigrateGraph.nodes)['claimable']['proofAvailable'],
): Observable<ClaimOutcome> {
    const bridgeInterface = NoriTempoTokenBridge__factory.createInterface();
    return from(
        (async (): Promise<ClaimOutcome> => {
            const witness = await getVerifiedRequestWitness(
                connections.ethereum,
                proofAvailable,
                addresses.proofQueue,
            );
            if ((await firstValueFrom(walletOnChain$(connections.tempo.wallet))) === 'declined')
                return { outcome: 'declined', error: 'Switch your wallet to Tempo to claim' };
            const signer = await (await connections.tempo.wallet.ready()).getSigner();
            const receipt = await mintERC20(
                signer,
                addresses.tempoBridge,
                witness,
                proofAvailable.proofQueueBatchIndex,
            );
            return { outcome: 'claimed', claimTxHash: receipt.hash };
        })(),
    ).pipe(
        catchError((error: unknown) => {
            if (isError(error, 'ACTION_REJECTED'))
                return of<ClaimOutcome>({
                    outcome: 'declined',
                    error: 'You cancelled the claim in your wallet',
                });
            const name = isError(error, 'CALL_EXCEPTION')
                ? (error.revert?.name ??
                  (error.data ? bridgeInterface.parseError(error.data)?.name : undefined))
                : undefined;
            if (name === 'ZeroMintAmount')
                return of<ClaimOutcome>({ outcome: 'claimed', claimTxHash: '' });
            if (name === 'CommitmentMismatch')
                return of<ClaimOutcome>({
                    outcome: 'failed',
                    error: 'Only the recipient can claim: switch your wallet to that account',
                });
            return of<ClaimOutcome>({ outcome: 'failed', error: name ?? messageOf(error) });
        }),
    );
}

/**
 * The lock's receipt once it is mined, through Ethereum's calls order.
 *
 * @param ethereum The Ethereum chain.
 * @param txHash The lock's hash.
 * @returns The receipt, once; nothing when it cannot be read.
 */
function receiptOf$(
    ethereum: Connections['ethereum'],
    txHash: string,
): Observable<TransactionReceipt> {
    return defer(async () =>
        forCalls(ethereum, async (provider: EthereumProvider) =>
            provider.waitForTransaction(txHash),
        ),
    ).pipe(
        filter((receipt): receipt is TransactionReceipt => receipt !== null),
        catchError(() => EMPTY),
    );
}

/**
 * Keeps only the outcomes with one of `outcomes`, narrowed to them.
 *
 * @param outcome$ Outcomes.
 * @param outcomes The outcomes to keep.
 * @returns The outcomes with those names.
 */
function withOutcome<TAll extends { outcome: string }, TOutcome extends TAll['outcome']>(
    outcome$: Observable<TAll>,
    ...outcomes: TOutcome[]
): Observable<Extract<TAll, { outcome: TOutcome }>> {
    return outcome$.pipe(
        filter((read): read is Extract<TAll, { outcome: TOutcome }> =>
            outcomes.some((outcome) => outcome === read.outcome),
        ),
    );
}

/**
 * The request and quote of a state that carries them, for the next node.
 *
 * @param source A state's data with the quote.
 * @returns The request and the quote.
 */
const quoteOf = (source: MigrateRequest & Quote): MigrateRequest & Quote => ({
    amount: source.amount,
    recipient: source.recipient,
    owner: source.owner,
    symbol: source.symbol,
    decimals: source.decimals,
    units: source.units,
    balance: source.balance,
    allowance: source.allowance,
    paused: source.paused,
    queueFee: source.queueFee,
    fee: source.fee,
    net: source.net,
});

/**
 * Starts the migrate machine at `editing` with `initial`.
 *
 * @param connections The Ethereum and Tempo chains; reads go through their calls orders, the wallets sign.
 * @param addresses The token, the two bridges and the queue.
 * @param followLock Follows a lock's proof request until a committed batch covers it.
 * @param initial The request the form starts with.
 * @returns
 *   - `migrate`: the running machine.
 *   - `edit(request)`: replaces the request; a complete one is read once edits settle.
 *   - `retry()`: reads again after a failed read.
 *   - `lock()`: locks on Ethereum.
 *   - `claim()`: claims the proven lock on Tempo.
 *   - `another()`: starts another migration.
 */
export function createMigrateMachine(
    connections: Connections,
    addresses: MigrateAddresses,
    followLock: FollowLock,
    initial: MigrateRequest,
): {
    migrate: StartedMachine<MigrateState> & { stop: () => void };
    edit: (request: MigrateRequest) => void;
    retry: () => void;
    lock: () => void;
    claim: () => void;
    another: () => void;
} {
    const edit$ = new Subject<MigrateRequest>();
    const retry$ = new Subject<void>();
    const lock$ = new Subject<void>();
    const claim$ = new Subject<void>();
    const another$ = new Subject<void>();
    const started$ = new ReplaySubject<StartedMachine<MigrateState>>(1);
    const state$ = stateOf$(started$);

    // The outcome edges of `reading` share one read of the request it
    // carries; entering `reading` again, from itself on an edit, switches to
    // the new request.
    const read$ = state$.pipe(
        filter(
            (state): state is Extract<MigrateState, { node: 'reading' }> =>
                state.node === 'reading',
        ),
        switchMap(({ data }) => readQuote$(connections.ethereum, addresses, data)),
        share(),
    );
    // The outcome edges of `awaitingSignature` share one send per entry into it.
    const send$ = dataOnEntry$(state$, 'awaitingSignature').pipe(
        switchMap((request) => sendLock$(connections.ethereum.wallet, addresses, request)),
        share(),
    );
    // The outcome edges of `claiming` share one claim per entry into it.
    const claimSent$ = dataOnEntry$(state$, 'claiming').pipe(
        switchMap(({ proofAvailable }) => sendClaim$(connections, addresses, proofAvailable)),
        share(),
    );

    const machine = MigrateGraph.implement({
        editIncomplete: {
            $: () => edit$.pipe(filter((request) => !isComplete(request))),
            next: (request) => request,
        },
        editComplete: {
            $: () => edit$.pipe(debounceTime(EDIT_SETTLE_MS), filter(isComplete)),
            next: (request) => ({ ...request, failedReads: 0 }),
        },
        readArrived: {
            $: () => withOutcome(read$, 'succeeded'),
            next: ({ value }, _dest, { amount, recipient, owner }) => ({
                amount,
                recipient,
                owner,
                ...value,
            }),
        },
        readError: {
            $: () => withOutcome(read$, 'failed'),
            next: ({ error }, _dest, { amount, recipient, owner, failedReads }) => ({
                amount,
                recipient,
                owner,
                error,
                failedReads: failedReads + 1,
            }),
        },
        retryDue: {
            $: () =>
                dataOnEntry$(state$, 'readFailed').pipe(
                    switchMap(({ failedReads }) =>
                        timer(Math.min(RETRY_INITIAL_MS * 2 ** (failedReads - 1), RETRY_MAX_MS)),
                    ),
                ),
            next: (_due, _dest, { amount, recipient, owner, failedReads }) => ({
                amount,
                recipient,
                owner,
                failedReads,
            }),
        },
        connectionLost: {
            $: () => withOutcome(read$, 'connectionLost'),
            next: ({ waitingOn }, _dest, { amount, recipient, owner }) => ({
                amount,
                recipient,
                owner,
                waitingOn,
            }),
        },
        connectionsChanged: {
            $: () => waitingOnChanged$(connections),
            next: (waitingOn, _dest, { amount, recipient, owner }) => ({
                amount,
                recipient,
                owner,
                waitingOn,
            }),
        },
        connectionRestored: {
            $: () => bothReady$(connections),
            next: (_restored, _dest, { amount, recipient, owner }) => ({
                amount,
                recipient,
                owner,
                failedReads: 0,
            }),
        },
        retry: {
            $: () => retry$,
            next: (_retry, _dest, { amount, recipient, owner, failedReads }) => ({
                amount,
                recipient,
                owner,
                failedReads,
            }),
        },
        lock: {
            $: () => lock$,
            next: (_lock, _dest, source) => quoteOf(source),
        },
        signed: {
            $: () => withOutcome(send$, 'signed'),
            next: ({ txHash }, _dest, source) => ({ ...source, txHash }),
        },
        userDeclined: {
            $: () => withOutcome(send$, 'declined'),
            next: (_declined, _dest, source) => source,
        },
        sendRejected: {
            $: () => withOutcome(send$, 'failed'),
            next: ({ error }, _dest, source) => ({ ...source, error }),
        },
        transactionReverted: {
            // A lock that succeeds never emits here, and never completes:
            // ystate fails a node whose `$` completes without emitting
            $: () =>
                dataOnEntry$(state$, 'proving').pipe(
                    switchMap(({ txHash }) => receiptOf$(connections.ethereum, txHash)),
                    switchMap((receipt) => (receipt.status === 0 ? of(receipt) : NEVER)),
                ),
            next: (receipt, _dest, source) => ({
                ...quoteOf(source),
                error: `The lock ${receipt.hash} failed on Ethereum`,
            }),
        },
        proven: {
            $: () =>
                dataOnEntry$(state$, 'proving').pipe(
                    switchMap(({ txHash }) =>
                        followLock(txHash).pipe(
                            filter(
                                (
                                    request,
                                ): request is Extract<
                                    ProofRequestStateNodeUnion,
                                    { node: 'proofAvailable' }
                                > => request.node === 'proofAvailable',
                            ),
                            take(1),
                        ),
                    ),
                ),
            next: ({ data }, _dest, source) => ({
                ...quoteOf(source),
                txHash: source.txHash,
                proofAvailable: data,
                claimError: '',
            }),
        },
        claim: {
            $: () => claim$,
            next: (_claim, _dest, source) => ({ ...source, claimError: '' }),
        },
        claimed: {
            $: () => withOutcome(claimSent$, 'claimed'),
            next: ({ claimTxHash }, _dest, source) => ({
                ...quoteOf(source),
                txHash: source.txHash,
                claimTxHash,
            }),
        },
        claimDeclined: {
            $: () => withOutcome(claimSent$, 'declined'),
            next: ({ error }, _dest, source) => ({ ...source, claimError: error }),
        },
        claimRejected: {
            $: () => withOutcome(claimSent$, 'failed'),
            next: ({ error }, _dest, source) => ({ ...source, claimError: error }),
        },
        another: {
            $: () => another$,
            next: (_another, _dest, { amount, recipient, owner }) => ({
                amount,
                recipient,
                owner,
                failedReads: 0,
            }),
        },
    });

    const migrate = machine.close().start('editing', undefined, { editing: initial });
    started$.next(migrate);

    return {
        migrate,
        edit: (request: MigrateRequest) => edit$.next(request),
        retry: () => retry$.next(),
        lock: () => lock$.next(),
        claim: () => claim$.next(),
        another: () => another$.next(),
    };
}
