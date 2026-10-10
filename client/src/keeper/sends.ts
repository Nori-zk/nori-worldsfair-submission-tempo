import { filter, map, merge, type Observable, switchMap, timer } from 'rxjs';
import { type SignerTransactionState } from '@nori-zk/nori-bridge-tempo-sdk';

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
