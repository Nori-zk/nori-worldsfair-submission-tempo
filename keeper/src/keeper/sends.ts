import { type Interface, type Signer } from 'ethers';
import {
    catchError,
    filter,
    finalize,
    ignoreElements,
    map,
    merge,
    type Observable,
    of,
    switchMap,
    take,
    tap,
    timer,
} from 'rxjs';
import {
    type ConnectionName,
    type Connections,
    createSignerTransactionMachine,
    type SignerTransactionState,
    type TransactionCall,
} from '@nori-zk/nori-bridge-tempo-sdk';

/** A running signer transaction machine, as far as sending goes. */
interface Send {
    state$: Observable<SignerTransactionState>;
    send(): void;
}

/** A send that is over: mined (`confirmed` or `reverted`), or refused by the contract. */
export type SendOver = Extract<SignerTransactionState, { node: 'confirmed' | 'reverted' | 'refused' }>;

/** A send that ended without reaching the chain's verdict: failed, or its transaction replaced. */
export type SendLost = Extract<SignerTransactionState, { node: 'sendFailed' | 'notReadyToSend' | 'replaced' | 'dropped' }>;

/**
 * Whether a send is over: mined, or refused by the contract.
 *
 * @param state Its signer transaction machine's state.
 * @returns `true` once it is.
 */
export const sendOver = (state: SignerTransactionState): state is SendOver =>
    state.node === 'confirmed' || state.node === 'reverted' || state.node === 'refused';

/**
 * Whether a send ended without the chain's verdict.
 *
 * @param state Its signer transaction machine's state.
 * @returns `true` once it did.
 */
export const sendLost = (state: SignerTransactionState): state is SendLost =>
    state.node === 'sendFailed' ||
    state.node === 'notReadyToSend' ||
    state.node === 'replaced' ||
    state.node === 'dropped';

/**
 * How a send that is over ended.
 *
 * @param state Its signer transaction machine's state, mined or refused.
 * @returns `mined`, `reverted`, or the contract's error name.
 */
export const sendOutcomeOf = (state: SendOver): string =>
    state.node === 'refused' ? state.data.errorName : state.node === 'confirmed' ? 'mined' : 'reverted';

/**
 * Why a send ended without the chain's verdict, in words.
 *
 * @param state Its signer transaction machine's state.
 * @returns The reason.
 */
export const sendLostReason = (state: SendLost): string => {
    switch (state.node) {
        case 'sendFailed':
            return state.data.error;
        case 'notReadyToSend':
            return `not ready to send: waiting on ${state.data.waitingOn.join(', ')}`;
        case 'replaced':
            return `replaced by another transaction from ${state.data.from}`;
        case 'dropped':
            return 'dropped by the node';
    }
};

/**
 * Keeps each send going for as long as the machines run: sends it on each
 * entry into `ready` (made, or back from `notReadyToSend`), and again
 * `resendAfterMs` after it failed or was dropped.
 *
 * @param sends$ The running signer transaction machines.
 * @param resendAfterMs How long a failed send waits before it is sent again.
 * @returns The subscription; unsubscribing stops it.
 */
export const keepSending = (sends$: Observable<Send[]>, resendAfterMs: number) =>
    sends$
        .pipe(
            switchMap((sends) =>
                merge(
                    ...sends.map((send) =>
                        send.state$.pipe(
                            map(({ node }) => node),
                            filter((node) => node === 'ready' || node === 'sendFailed' || node === 'dropped'),
                            switchMap((node) => timer(node === 'ready' ? 0 : resendAfterMs).pipe(map(() => send)))
                        )
                    )
                )
            )
        )
        .subscribe((send) => send.send());

/** How a send ended: over (mined or refused by the contract, `outcome`), or failed to send (`failed`). */
export type SendEnd = { outcome: string } | { failed: string };

/**
 * One transaction sent with a signer, made for the call `call$` gives and
 * sent at once, until it is mined, refused by the contract, or ends without
 * the chain's verdict. A call that cannot be made (a read it needs failed)
 * fails to send.
 *
 * @param connections The Ethereum and Tempo chains, from `createConnections`.
 * @param chain The chain it is sent on.
 * @param signer The signer there.
 * @param call$ The call: the contract, its data and the value, once.
 * @param errors The contract's error ABI, to name a refusal.
 * @param resendAfterMs How long a failed send waits before it is sent again.
 * @param sent Called once with its hash when it is sent.
 * @returns How it ended, once.
 */
export function sendOnce$(
    connections: Connections,
    chain: ConnectionName,
    signer: Signer,
    call$: Observable<TransactionCall>,
    errors: Interface,
    resendAfterMs: number,
    sent: (hash: string) => void = () => undefined
): Observable<SendEnd> {
    return call$.pipe(
        take(1),
        map((call) => ({ call })),
        catchError((error: unknown) => of({ cannotMake: error instanceof Error ? error.message : String(error) })),
        switchMap((made): Observable<SendEnd> => {
            if ('cannotMake' in made) return of({ failed: made.cannotMake });
            const transaction = createSignerTransactionMachine(connections, chain, signer, made.call, {
                errors,
            });
            // Sent on each entry into `ready`: at once, and again once a connection still
            // being checked is usable (`notReadyToSend` moves back to `ready` by itself).
            const sending = keepSending(of([transaction]), resendAfterMs);
            return merge(
                transaction.state$.pipe(
                    map((state) => ('transactionHash' in state.data ? state.data.transactionHash : '')),
                    filter((hash) => hash !== ''),
                    take(1),
                    tap(sent),
                    ignoreElements()
                ),
                transaction.state$.pipe(
                    filter(
                        (state): state is SendOver | SendLost =>
                            sendOver(state) || (sendLost(state) && state.node !== 'notReadyToSend')
                    ),
                    take(1),
                    map((state): SendEnd =>
                        sendOver(state) ? { outcome: sendOutcomeOf(state) } : { failed: sendLostReason(state) }
                    )
                )
            ).pipe(
                take(1),
                finalize(() => {
                    sending.unsubscribe();
                    transaction.close();
                })
            );
        })
    );
}
