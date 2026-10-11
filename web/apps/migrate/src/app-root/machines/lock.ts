import { define, type StateUnion } from '@yaw-rx/ystate';
import { readThroughConnectionsOf } from '@nori-zk/nori-bridge-tempo-sdk';
import type { Quote } from './quote.js';

/** What the user asked to lock: an amount, for a Tempo recipient, from the wallet's account. */
const request = {
    /** In the token's units, at most 6 decimals. */
    amount: '',
    /** The Tempo address the lock commits to. */
    recipient: '',
    /** The Ethereum account that locks. */
    holder: '',
};

/** A quote read, before there is one. */
const noQuote: Quote = {
    symbol: '',
    decimals: 18,
    units: 0n,
    balance: 0n,
    allowance: 0n,
    erc20Paused: false,
    fee: 0n,
    net: 0n,
    queueFee: 0n,
};

/** The quote, read through Ethereum and kept current: the read shape, spread. */
const quoting = readThroughConnectionsOf({ ...request, quote: undefined as Quote | undefined });

/**
 * Locking an ERC-20 on Ethereum for a Tempo recipient, as the user's steps.
 * The quote is this graph's own read (`readThroughConnectionsOf`, spread):
 * `loading`, `current`, `refreshing` and their waits and failures are the
 * user looking at the quote for the request their data holds. No node is a
 * dead end.
 *
 * - `noAccount`: the wallet shares no account yet. The first account it
 *   shares (the account machine, as a gate) becomes the holder and the
 *   recipient (`editing`, as there is no amount yet).
 * - `editing`: the amount or recipient is not valid yet. Every edit carries
 *   the whole request: a complete one reads its quote (`loading`), an
 *   incomplete one returns here, from every node where the form is open. A
 *   new account moves the holder, and the recipient with it while they were
 *   the same.
 * - `current` (or `refreshing`, holding a quote): `lock` goes ahead only
 *   while the issuer has not paused the token and the holder holds the
 *   amount (a gate on the quote). When the bridge may not take the amount
 *   yet, the wallet is first asked to `approve` it (`approving`, until the
 *   approval is confirmed), then to sign `lockERC20` (`signing`). The user
 *   says no (`declined`), the wallet or contract refuses (`sendFailed`), or
 *   the lock is sent (`locked`, with its hash). `lock` asks again from
 *   either; an edit returns to the form.
 * - `locked` hands the lock to its claim on Tempo; a revert (status 0) is
 *   `reverted`, which `lock` sends again. `another` reads the same request
 *   again for another lock.
 */
export const LockGraph = define({
    nodes: {
        noAccount: { ...request },
        editing: { ...request },
        ...quoting.nodes,
        approving: { ...request, quote: noQuote },
        signing: { ...request, quote: noQuote },
        declined: { ...request, quote: noQuote },
        sendFailed: { ...request, quote: noQuote, error: '' },
        locked: { ...request, quote: noQuote, txHash: '' },
        reverted: { ...request, quote: noQuote, txHash: '' },
    },
    edges: {
        ...quoting.edges,

        accountShared: { from: 'noAccount', to: 'editing', on: 'accountShared.next' },
        accountChangedWhileEditing: {
            from: 'editing',
            to: 'editing',
            on: 'accountChangedWhileEditing.next',
        },
        accountChangedWhileLoading: { from: 'loading', to: 'loading', on: 'accountChanged.next' },
        accountChangedWhileCurrent: { from: 'current', to: 'loading', on: 'accountChanged.next' },
        accountChangedWhileRefreshing: {
            from: 'refreshing',
            to: 'loading',
            on: 'accountChanged.next',
        },
        accountChangedWhileWaitingForConnectionWhileLoading: {
            from: 'waitingForConnectionWhileLoading',
            to: 'loading',
            on: 'accountChanged.next',
        },
        accountChangedWhileWaitingForConnectionWhileRefreshing: {
            from: 'waitingForConnectionWhileRefreshing',
            to: 'loading',
            on: 'accountChanged.next',
        },
        accountChangedWhileFailedWhileLoading: {
            from: 'failedWhileLoading',
            to: 'loading',
            on: 'accountChanged.next',
        },
        accountChangedWhileFailedWhileRefreshing: {
            from: 'failedWhileRefreshing',
            to: 'loading',
            on: 'accountChanged.next',
        },

        editedIncomplete: { from: 'editing', to: 'editing', on: 'editIncomplete.next' },
        editedComplete: { from: 'editing', to: 'loading', on: 'editComplete.next' },
        editedIncompleteWhileLoading: { from: 'loading', to: 'editing', on: 'editIncomplete.next' },
        editedWhileLoading: { from: 'loading', to: 'loading', on: 'editComplete.next' },
        editedIncompleteWhileCurrent: { from: 'current', to: 'editing', on: 'editIncomplete.next' },
        editedWhileCurrent: { from: 'current', to: 'loading', on: 'editComplete.next' },
        editedIncompleteWhileRefreshing: {
            from: 'refreshing',
            to: 'editing',
            on: 'editIncomplete.next',
        },
        editedWhileRefreshing: { from: 'refreshing', to: 'loading', on: 'editComplete.next' },
        editedIncompleteWhileWaitingForConnectionWhileLoading: {
            from: 'waitingForConnectionWhileLoading',
            to: 'editing',
            on: 'editIncomplete.next',
        },
        editedWhileWaitingForConnectionWhileLoading: {
            from: 'waitingForConnectionWhileLoading',
            to: 'loading',
            on: 'editComplete.next',
        },
        editedIncompleteWhileWaitingForConnectionWhileRefreshing: {
            from: 'waitingForConnectionWhileRefreshing',
            to: 'editing',
            on: 'editIncomplete.next',
        },
        editedWhileWaitingForConnectionWhileRefreshing: {
            from: 'waitingForConnectionWhileRefreshing',
            to: 'loading',
            on: 'editComplete.next',
        },
        editedIncompleteWhileFailedWhileLoading: {
            from: 'failedWhileLoading',
            to: 'editing',
            on: 'editIncomplete.next',
        },
        editedWhileFailedWhileLoading: {
            from: 'failedWhileLoading',
            to: 'loading',
            on: 'editComplete.next',
        },
        editedIncompleteWhileFailedWhileRefreshing: {
            from: 'failedWhileRefreshing',
            to: 'editing',
            on: 'editIncomplete.next',
        },
        editedWhileFailedWhileRefreshing: {
            from: 'failedWhileRefreshing',
            to: 'loading',
            on: 'editComplete.next',
        },
        editedIncompleteAfterDecline: {
            from: 'declined',
            to: 'editing',
            on: 'editIncomplete.next',
        },
        editedAfterDecline: { from: 'declined', to: 'loading', on: 'editComplete.next' },
        editedIncompleteAfterSendFailed: {
            from: 'sendFailed',
            to: 'editing',
            on: 'editIncomplete.next',
        },
        editedAfterSendFailed: { from: 'sendFailed', to: 'loading', on: 'editComplete.next' },
        editedIncompleteAfterRevert: { from: 'reverted', to: 'editing', on: 'editIncomplete.next' },
        editedAfterRevert: { from: 'reverted', to: 'loading', on: 'editComplete.next' },

        approveRequested: { from: 'current', to: 'approving', on: 'approve.next' },
        approveRequestedWhileRefreshing: {
            from: 'refreshing',
            to: 'approving',
            on: 'approve.next',
        },
        approveAgainAfterDecline: { from: 'declined', to: 'approving', on: 'approve.next' },
        approveAgainAfterSendFailed: { from: 'sendFailed', to: 'approving', on: 'approve.next' },
        approveAgainAfterRevert: { from: 'reverted', to: 'approving', on: 'approve.next' },
        lockRequested: { from: 'current', to: 'signing', on: 'lock.next' },
        lockRequestedWhileRefreshing: { from: 'refreshing', to: 'signing', on: 'lock.next' },
        lockAgainAfterDecline: { from: 'declined', to: 'signing', on: 'lock.next' },
        lockAgainAfterSendFailed: { from: 'sendFailed', to: 'signing', on: 'lock.next' },
        lockAgainAfterRevert: { from: 'reverted', to: 'signing', on: 'lock.next' },

        approved: { from: 'approving', to: 'signing', on: 'approved.next' },
        userDeclinedApproval: { from: 'approving', to: 'declined', on: 'approvalDeclined.next' },
        approvalRefused: { from: 'approving', to: 'sendFailed', on: 'approvalRefused.next' },
        userDeclined: { from: 'signing', to: 'declined', on: 'userDeclined.next' },
        sendRefused: { from: 'signing', to: 'sendFailed', on: 'sendRefused.next' },
        sent: { from: 'signing', to: 'locked', on: 'sent.next' },

        transactionReverted: { from: 'locked', to: 'reverted', on: 'transactionReverted.next' },
        anotherRequested: { from: 'locked', to: 'loading', on: 'another.next' },
    },
});

/** Locking: a node of the graph and its data. */
export type LockState = StateUnion<typeof LockGraph.nodes>;
