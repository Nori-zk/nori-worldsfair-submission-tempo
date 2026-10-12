import {
    combineLatest,
    distinctUntilChanged,
    filter,
    map,
    merge,
    NEVER,
    type Observable,
    type Subscription,
    switchMap,
} from 'rxjs';
import {
    type createWalletTransactionMachine,
    type EthereumWalletState,
    type ProofRequestConnections,
} from '@nori-zk/nori-bridge-tempo-sdk';

/** A running wallet transaction machine. */
type WalletTransaction = ReturnType<typeof createWalletTransactionMachine>;

/**
 * Sends a flow's wallet transaction on its chain: each time the transaction
 * is ready (made, or back once its wallet is usable), and, while it waits on
 * a wallet that is on the other chain, asks the wallet to switch. One
 * browser wallet signs on both chains here: the lock on Ethereum, the claim
 * on Tempo.
 *
 * @param connections The Ethereum and Tempo chains, with their wallets.
 * @param chain The chain the transaction is sent on.
 * @param transaction$ The flow's transaction on that chain, while it has one.
 * @returns The subscription; unsubscribing stops it.
 */
export function sendOnChain(
    connections: ProofRequestConnections,
    chain: 'ethereum' | 'tempo',
    transaction$: Observable<WalletTransaction | undefined>,
): Subscription {
    const { wallet } = connections[chain];
    const nodes$ = transaction$.pipe(
        switchMap((transaction) =>
            transaction === undefined
                ? NEVER
                : transaction.state$.pipe(
                      map(({ node }) => ({ transaction, node })),
                      distinctUntilChanged((before, now) => before.node === now.node),
                  ),
        ),
    );
    const wrongNetwork$: Observable<boolean> =
        wallet.connection?.state$.pipe(
            map((state: EthereumWalletState) => state.node === 'wrongNetwork'),
        ) ?? NEVER;
    return merge(
        nodes$.pipe(
            filter(({ node }) => node === 'ready'),
            map(
                ({ transaction }) =>
                    () =>
                        transaction.send(),
            ),
        ),
        combineLatest([
            nodes$.pipe(map(({ node }) => node === 'notReadyToSend')),
            wrongNetwork$,
        ]).pipe(
            map(([waiting, wrongNetwork]) => waiting && wrongNetwork),
            distinctUntilChanged(),
            filter(Boolean),
            map(() => () => wallet.switchToExpectedChain()),
        ),
    ).subscribe((act) => act());
}
