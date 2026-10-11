import { define, type StateUnion } from '@yaw-rx/ystate';
import type {
    ProofAvailableProofRequestSnapshot,
    VerifiedRequestWitness,
} from '@nori-zk/nori-bridge-tempo-sdk';

/** The lock a claim is made for: its transaction, and the Tempo address it committed to. */
export interface LockToClaim {
    txHash: string;
    recipient: string;
}

const lock = { txHash: '', recipient: '' } as LockToClaim;
const proofAvailable = {} as ProofAvailableProofRequestSnapshot;
const verifiedWitness = {} as VerifiedRequestWitness;

/**
 * Claiming one lock on Tempo, made for the lock (its starting data). It
 * gates on three other machines' states: the lock's proof request machine
 * (`ProofProgressService`, shared with the progress bar), the witness
 * machine started from the batch that proves it, and the claim's wallet
 * transaction machine on Tempo.
 *
 * - `waitingForProof`: Nori has not committed a batch covering the lock
 *   yet. A lock transaction that never enqueued its request ends in
 *   `lockReplaced` or `lockDropped`.
 * - `readingWitness` holds the batch while the lock's witness in it is read.
 * - `claimable` holds the witness until the user claims (`claim`).
 * - `claiming`: the wallet, switched to Tempo, sends `mintERC20` from the
 *   recipient, and it is followed until mined. It ends `claimed`; or
 *   `alreadyClaimed` when there was nothing left to mint (a later claim
 *   minted this lock too); or the user says no (`claimDeclined`); or the
 *   bridge or the token refuses it, it reverts or it is lost
 *   (`claimFailed`, with the reason, as when the issuer has paused the
 *   TIP-20). `claim` asks again from either.
 */
export const ClaimGraph = define({
    nodes: {
        waitingForProof: { lock },
        lockReplaced: { lock },
        lockDropped: { lock },
        readingWitness: { lock, proofAvailable },
        claimable: { lock, proofAvailable, verifiedWitness },
        claiming: { lock, proofAvailable, verifiedWitness },
        claimDeclined: { lock, proofAvailable, verifiedWitness },
        claimFailed: { lock, proofAvailable, verifiedWitness, error: '' },
        claimed: { lock, claimTxHash: '' },
        alreadyClaimed: { lock },
    },
    edges: {
        proofAvailable: {
            from: 'waitingForProof',
            to: 'readingWitness',
            on: 'proofAvailable.next',
        },
        replaced: { from: 'waitingForProof', to: 'lockReplaced', on: 'lockReplaced.next' },
        dropped: { from: 'waitingForProof', to: 'lockDropped', on: 'lockDropped.next' },
        witnessRead: { from: 'readingWitness', to: 'claimable', on: 'witnessRead.next' },
        claimRequested: { from: 'claimable', to: 'claiming', on: 'claim.next' },
        claimAgainAfterDecline: { from: 'claimDeclined', to: 'claiming', on: 'claim.next' },
        claimAgainAfterFailure: { from: 'claimFailed', to: 'claiming', on: 'claim.next' },
        userDeclined: { from: 'claiming', to: 'claimDeclined', on: 'userDeclined.next' },
        claimRefused: { from: 'claiming', to: 'claimFailed', on: 'claimRefused.next' },
        nothingLeftToMint: { from: 'claiming', to: 'alreadyClaimed', on: 'nothingLeftToMint.next' },
        claimConfirmed: { from: 'claiming', to: 'claimed', on: 'claimConfirmed.next' },
    },
});

/** Claiming a lock: a node of the graph and its data. */
export type ClaimState = StateUnion<typeof ClaimGraph.nodes>;
