import {
    ProofRequestState,
    forCalls,
    getProofRequestStateSnapshot,
    getProofRequestWitness,
    type Ethereum,
    type EthereumProvider,
    type Tempo,
} from '@nori-zk/nori-bridge-tempo-sdk';
import {
    parseSnapshotEvent,
    snapshotResultWitness,
    type SnapshotEvent,
    type SnapshotResultWitnessArgs,
} from './snapshotWitness.js';

export interface ProvenSnapshotRequest {
    /** The sdk's chains, from `createConnections`. */
    connections: { ethereum: Ethereum; tempo: Tempo };
    noriSnapshot: string;
    proofQueue: string;
    /** The transaction that called `NoriSnapshot.snapshot`. */
    snapshotTxHash: string;
    /** The `NoriTempoTokenBridge` that proves the queue. */
    bridgeAddress: string;
}

export type ProvenSnapshot =
    | { proven: false; event: SnapshotEvent }
    | {
          proven: true;
          event: SnapshotEvent;
          /** The index of the committed batch holding the snapshot. */
          proofQueueBatchIndex: bigint;
          /** The witness a Tempo contract verifies for one query's result. */
          witnessFor(queryId: string): SnapshotResultWitnessArgs;
      };

const fetchReceipt = (provider: EthereumProvider, hash: string) =>
    provider.getTransactionReceipt(hash);

/**
 * A snapshot transaction and, once Nori has proven its batch, everything
 * needed to verify any of its results: the batch index, and the request's
 * path in it (fetched once, shared by every query).
 */
export async function fetchProvenSnapshot(
    request: ProvenSnapshotRequest
): Promise<ProvenSnapshot> {
    const { ethereum } = request.connections;
    const receipt = await forCalls(
        ethereum,
        fetchReceipt,
        request.snapshotTxHash
    );
    if (!receipt) throw new Error(`No receipt for ${request.snapshotTxHash}`);
    const event = parseSnapshotEvent(receipt, request.noriSnapshot);

    const state = await getProofRequestStateSnapshot(request.connections, {
        proofQueueAddress: request.proofQueue,
        proofRequestTxHash: request.snapshotTxHash,
        bridgeAddress: request.bridgeAddress,
    });
    if (state.state !== ProofRequestState.ProofAvailable)
        return { proven: false, event };

    const requestWitness = await getProofRequestWitness(
        ethereum,
        state,
        request.proofQueue
    );
    return {
        proven: true,
        event,
        proofQueueBatchIndex: state.proofQueueBatchIndex,
        witnessFor: (queryId) =>
            snapshotResultWitness(
                request.noriSnapshot,
                event,
                queryId,
                requestWitness
            ),
    };
}
