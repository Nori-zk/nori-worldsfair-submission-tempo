import { define, type StateUnion } from '@yaw-rx/ystate';
import { readThroughConnectionsOf } from '@nori-zk/nori-bridge-tempo-sdk';
import type { Preview } from './preview.js';

/** What the user asked to prove: an asset's balance held by an address. */
const request = {
    /** `eth`, or an ERC-20 token's address. */
    asset: '',
    /** The Ethereum address whose balance is proven. */
    holder: '',
};

/** A preview read, before there is one. */
const noPreview: Preview = { symbol: '', decimals: 18, balance: 0n, fee: 0n };

/** The balance and fee, read through the wallet and kept current: the read shape, spread. */
const previewing = readThroughConnectionsOf({ ...request, preview: undefined as Preview | undefined });

/**
 * Proving a balance, as the user's steps. The balance and fee are this
 * graph's own read (`readThroughConnectionsOf`, spread): `loading`,
 * `current`, `refreshing` and their waits and failures are the user looking
 * at the balance of the request their data holds. No node is a dead end.
 *
 * - `noAccount`: the wallet shares no account yet. The first account it
 *   shares (the account machine, as a gate) reads ETH for it (`loading`).
 * - `editing`: the asset or holder is not valid yet. Every edit carries the
 *   whole request: a complete one reads it (`loading`), an incomplete one
 *   returns here, from every node where the form is open. A new account
 *   moves the holder with it while they were the same.
 * - `current` (or `refreshing`, holding a balance): `prove` asks the wallet
 *   to sign one `NoriSnapshot.snapshot` (`signing`, gated by the wallet
 *   transaction machine started on entry). The user says no (`declined`),
 *   the wallet or contract refuses (`sendFailed`), or it is sent (`proving`,
 *   with its hash). `prove` asks again from either; an edit returns to the
 *   form.
 * - `proving` follows the transaction's receipt and the proof; a revert
 *   (status 0) is `reverted`, which `prove` sends again. `another` reads the
 *   same request again for another proof.
 */
export const ProveBalanceGraph = define({
    nodes: {
        noAccount: { ...request },
        editing: { ...request },
        ...previewing.nodes,
        signing: { ...request, preview: noPreview },
        declined: { ...request, preview: noPreview },
        sendFailed: { ...request, preview: noPreview, error: '' },
        proving: { ...request, preview: noPreview, txHash: '' },
        reverted: { ...request, preview: noPreview, txHash: '' },
    },
    edges: {
        ...previewing.edges,

        accountShared: { from: 'noAccount', to: 'loading', on: 'accountShared.next' },
        accountChangedWhileEditing: { from: 'editing', to: 'editing', on: 'accountChangedWhileEditing.next' },
        accountChangedWhileLoading: { from: 'loading', to: 'loading', on: 'accountChanged.next' },
        accountChangedWhileCurrent: { from: 'current', to: 'loading', on: 'accountChanged.next' },
        accountChangedWhileRefreshing: { from: 'refreshing', to: 'loading', on: 'accountChanged.next' },
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
        accountChangedWhileFailedWhileLoading: { from: 'failedWhileLoading', to: 'loading', on: 'accountChanged.next' },
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
        editedIncompleteWhileRefreshing: { from: 'refreshing', to: 'editing', on: 'editIncomplete.next' },
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
        editedIncompleteWhileFailedWhileLoading: { from: 'failedWhileLoading', to: 'editing', on: 'editIncomplete.next' },
        editedWhileFailedWhileLoading: { from: 'failedWhileLoading', to: 'loading', on: 'editComplete.next' },
        editedIncompleteWhileFailedWhileRefreshing: {
            from: 'failedWhileRefreshing',
            to: 'editing',
            on: 'editIncomplete.next',
        },
        editedWhileFailedWhileRefreshing: { from: 'failedWhileRefreshing', to: 'loading', on: 'editComplete.next' },
        editedIncompleteAfterDecline: { from: 'declined', to: 'editing', on: 'editIncomplete.next' },
        editedAfterDecline: { from: 'declined', to: 'loading', on: 'editComplete.next' },
        editedIncompleteAfterSendFailed: { from: 'sendFailed', to: 'editing', on: 'editIncomplete.next' },
        editedAfterSendFailed: { from: 'sendFailed', to: 'loading', on: 'editComplete.next' },
        editedIncompleteAfterRevert: { from: 'reverted', to: 'editing', on: 'editIncomplete.next' },
        editedAfterRevert: { from: 'reverted', to: 'loading', on: 'editComplete.next' },

        proveRequested: { from: 'current', to: 'signing', on: 'prove.next' },
        proveRequestedWhileRefreshing: { from: 'refreshing', to: 'signing', on: 'prove.next' },
        userDeclined: { from: 'signing', to: 'declined', on: 'userDeclined.next' },
        sendRefused: { from: 'signing', to: 'sendFailed', on: 'sendRefused.next' },
        sent: { from: 'signing', to: 'proving', on: 'sent.next' },
        proveAgainAfterDecline: { from: 'declined', to: 'signing', on: 'prove.next' },
        proveAgainAfterSendFailed: { from: 'sendFailed', to: 'signing', on: 'prove.next' },

        transactionReverted: { from: 'proving', to: 'reverted', on: 'transactionReverted.next' },
        anotherRequested: { from: 'proving', to: 'loading', on: 'another.next' },
        proveAgainAfterRevert: { from: 'reverted', to: 'signing', on: 'prove.next' },
    },
});

/** Proving a balance: a node of the graph and its data. */
export type ProveBalanceState = StateUnion<typeof ProveBalanceGraph.nodes>;
