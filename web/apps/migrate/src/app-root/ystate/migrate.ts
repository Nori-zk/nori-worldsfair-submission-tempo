import { define, type StateUnion } from '@yaw-rx/ystate';
import { type ConnectionName, ProofRequestStateGraph } from '@nori-zk/nori-bridge-tempo-sdk';

/** What the user asked to migrate: an amount, from the wallet's account, to a Tempo address. */
const request = {
    /** The amount, in the token's units, as typed: at most 6 decimals, a TIP-20's. */
    amount: '',
    /** The Tempo address the TIP-20 is minted to; only it can claim. */
    recipient: '',
    /** The wallet's Ethereum account, whose tokens are locked. */
    owner: '',
};

/** The request with what reading it found. */
const readRequest = {
    ...request,
    /** The ERC-20's `symbol()`. */
    symbol: '',
    /** The ERC-20's `decimals()`. */
    decimals: 18,
    /** The amount, in the ERC-20's smallest unit. */
    units: 0n as bigint,
    /** The owner's balance, in the ERC-20's smallest unit. */
    balance: 0n as bigint,
    /** What the owner has approved the token bridge to take. */
    allowance: 0n as bigint,
    /** Whether the ERC-20 is paused on Ethereum: a lock would revert. */
    paused: false,
    /** The proof queue's fee, in wei, paid in ETH with the lock. */
    queueFee: 0n as bigint,
    /** The bridge's rate fee and the net locked, in the ERC-20's smallest unit. */
    fee: 0n as bigint,
    net: 0n as bigint,
};

/** A lock whose proof is on Tempo: what the claim mints against. */
const provenLock = {
    ...readRequest,
    /** The `lockERC20` transaction. */
    txHash: '',
    /** The proof request's state once a committed batch covers it. */
    proofAvailable: ProofRequestStateGraph.nodes.proofAvailable,
    /** Why the last claim did not go through, or empty. */
    claimError: '',
};

/**
 * Migrating an ERC-20 to its TIP-20 on Tempo: the user types an amount and a
 * Tempo recipient, the token is read as soon as both are valid, one lock on
 * Ethereum retires it there, and once Nori's proof of the lock is on Tempo
 * the recipient claims the TIP-20. No node is a dead end.
 *
 * - Every edit carries the whole request. `editIncomplete` (the amount or
 *   recipient is not valid yet) goes to `editing`; `editComplete` goes to
 *   `reading`, from any node where the form is open, including `reading`
 *   itself, which reads again for the new request.
 * - `reading` reads the token (symbol, decimals, the owner's balance and
 *   allowance, `paused()`) and the bridge's quote (`previewLockERC20`)
 *   through Ethereum's calls order. A connection that is down is
 *   `waitingForConnection`; a read that fails is `readFailed`, which reads
 *   again by itself after a wait that doubles with each failed read in a row,
 *   or at once on `retry`.
 * - `readyToLock` shows the quote. `lock` asks the wallet onto Ethereum and
 *   sends an `approve` when the allowance falls short, then
 *   `NoriTokenBridge.lockERC20` (`awaitingSignature`). Declining goes to
 *   `declined`, any other failure to `sendFailed`; both can lock again or
 *   be edited.
 * - `proving` carries the lock's hash while the proof request machine
 *   follows it, through Ethereum finality and Nori's prover, until a
 *   committed batch on Tempo covers it: `proven`, to `claimable`. A lock
 *   that reverts on Ethereum goes to `sendFailed`.
 * - `claim` asks the wallet onto Tempo and sends `mintERC20` with the
 *   lock's witness (`claiming`). Declining or a failure goes back to
 *   `claimable` with the reason, to claim again. `claimed` carries the claim's
 *   hash; `another` reads the same request again for another lock.
 */
export const MigrateGraph = define({
    nodes: {
        editing: { ...request },
        reading: { ...request, failedReads: 0 },
        waitingForConnection: { ...request, waitingOn: [] as ConnectionName[] },
        readFailed: { ...request, error: '', failedReads: 0 },
        readyToLock: { ...readRequest },
        awaitingSignature: { ...readRequest },
        declined: { ...readRequest },
        sendFailed: { ...readRequest, error: '' },
        proving: { ...readRequest, txHash: '' },
        claimable: { ...provenLock },
        claiming: { ...provenLock },
        claimed: { ...readRequest, txHash: '', claimTxHash: '' },
    },
    edges: {
        editedIncomplete: { from: 'editing', to: 'editing', on: 'editIncomplete.next' },
        editedComplete: { from: 'editing', to: 'reading', on: 'editComplete.next' },
        editedIncompleteWhileReading: { from: 'reading', to: 'editing', on: 'editIncomplete.next' },
        editedWhileReading: { from: 'reading', to: 'reading', on: 'editComplete.next' },
        editedIncompleteWhileWaiting: {
            from: 'waitingForConnection',
            to: 'editing',
            on: 'editIncomplete.next',
        },
        editedWhileWaiting: {
            from: 'waitingForConnection',
            to: 'reading',
            on: 'editComplete.next',
        },
        editedIncompleteAfterFailure: {
            from: 'readFailed',
            to: 'editing',
            on: 'editIncomplete.next',
        },
        editedAfterFailure: { from: 'readFailed', to: 'reading', on: 'editComplete.next' },
        editedIncompleteWhenReady: {
            from: 'readyToLock',
            to: 'editing',
            on: 'editIncomplete.next',
        },
        editedWhenReady: { from: 'readyToLock', to: 'reading', on: 'editComplete.next' },
        editedIncompleteAfterDecline: {
            from: 'declined',
            to: 'editing',
            on: 'editIncomplete.next',
        },
        editedAfterDecline: { from: 'declined', to: 'reading', on: 'editComplete.next' },
        editedIncompleteAfterSendFailure: {
            from: 'sendFailed',
            to: 'editing',
            on: 'editIncomplete.next',
        },
        editedAfterSendFailure: { from: 'sendFailed', to: 'reading', on: 'editComplete.next' },

        readArrived: { from: 'reading', to: 'readyToLock', on: 'readArrived.next' },
        readErrored: { from: 'reading', to: 'readFailed', on: 'readError.next' },
        connectionLost: { from: 'reading', to: 'waitingForConnection', on: 'connectionLost.next' },
        connectionsChanged: {
            from: 'waitingForConnection',
            to: 'waitingForConnection',
            on: 'connectionsChanged.next',
        },
        connectionRestored: {
            from: 'waitingForConnection',
            to: 'reading',
            on: 'connectionRestored.next',
        },
        retried: { from: 'readFailed', to: 'reading', on: 'retry.next' },
        retryStarted: { from: 'readFailed', to: 'reading', on: 'retryDue.next' },

        lockRequested: { from: 'readyToLock', to: 'awaitingSignature', on: 'lock.next' },
        lockRetriedAfterDecline: { from: 'declined', to: 'awaitingSignature', on: 'lock.next' },
        lockRetriedAfterFailure: { from: 'sendFailed', to: 'awaitingSignature', on: 'lock.next' },
        signed: { from: 'awaitingSignature', to: 'proving', on: 'signed.next' },
        userDeclined: { from: 'awaitingSignature', to: 'declined', on: 'userDeclined.next' },
        sendRejected: { from: 'awaitingSignature', to: 'sendFailed', on: 'sendRejected.next' },
        transactionReverted: { from: 'proving', to: 'sendFailed', on: 'transactionReverted.next' },

        provenOnTempo: { from: 'proving', to: 'claimable', on: 'proven.next' },
        claimRequested: { from: 'claimable', to: 'claiming', on: 'claim.next' },
        claimLanded: { from: 'claiming', to: 'claimed', on: 'claimed.next' },
        claimDeclined: { from: 'claiming', to: 'claimable', on: 'claimDeclined.next' },
        claimRejected: { from: 'claiming', to: 'claimable', on: 'claimRejected.next' },
        anotherRequested: { from: 'claimed', to: 'reading', on: 'another.next' },
    },
});

/** Migrating an ERC-20: a node of the graph and its data. */
export type MigrateState = StateUnion<typeof MigrateGraph.nodes>;
