import { Injectable } from '@yaw-rx/core';
import { distinctUntilChanged, map, Observable, of, shareReplay, switchMap } from 'rxjs';
import {
    createProofRequestStateMachine,
    createUnprocessedProofRequestStateMachine,
    ProofRequestState,
    type ProofRequestStateNodeUnion,
    type UnprocessedProofRequestStateNodeUnion,
} from '@nori-zk/nori-bridge-tempo-sdk';
import { ConnectionsService } from './connections.service.js';
import { NoriBridgeInfraService } from './nori-bridge-infra.service.js';

/**
 * The block an unprocessed request was enqueued in: while the proof request
 * machine holds it as `unprocessed`, read or being read again.
 *
 * @param request The proof request machine's state.
 * @returns The block, or `undefined` while the request is not known to be unprocessed.
 */
const unprocessedBlockOf = (request: ProofRequestStateNodeUnion): bigint | undefined =>
    'snapshot' in request.data && request.data.snapshot.state === ProofRequestState.Unprocessed
        ? request.data.snapshot.requestBlockNumber
        : undefined;

/** One followed proof request: its state, its bridge progress while unprocessed, and its controls. */
export interface FollowedProof {
    /** The proof request machine's states. */
    request$: Observable<ProofRequestStateNodeUnion>;
    /** The unprocessed machine's states while the request is `unprocessed`, else `undefined`. */
    progress$: Observable<UnprocessedProofRequestStateNodeUnion | undefined>;
    /** Reads again now, while a read has failed. */
    retry: () => void;
}

/**
 * Follows proof requests for the app's lifetime, one proof request machine
 * per transaction hash, so a view that is set up again finds its request
 * where it left it. While a request is `unprocessed`, the unprocessed
 * machine follows the bridge's progress on it from the websocket.
 */
@Injectable([ConnectionsService, NoriBridgeInfraService])
export class ProofProgressService {
    private readonly followed = new Map<string, FollowedProof & { close: () => void }>();

    /**
     * @param connections The connections, Nori's websocket among them, and the queue and bridge addresses.
     * @param noriBridgeInfra Nori's bridge state.
     */
    constructor(
        private readonly connections: ConnectionsService,
        private readonly noriBridgeInfra: NoriBridgeInfraService,
    ) {}

    /**
     * The proof request enqueued by `txHash`, followed from the first call on.
     *
     * @param txHash The transaction that enqueued the proof request.
     * @returns Its state, its bridge progress and `retry()`.
     */
    follow(txHash: string): FollowedProof {
        const existing = this.followed.get(txHash);
        if (existing) return existing;

        const { connections, options } = this.connections;
        const proofRequest = createProofRequestStateMachine(
            connections,
            { ...options.proofRequests, proofRequestTxHash: txHash },
            undefined,
            15_000,
            this.noriBridgeInfra.state$,
        );
        const request$ = proofRequest.state$.pipe(
            shareReplay({ bufferSize: 1, refCount: false }),
        );
        const progress$ = request$.pipe(
            map(unprocessedBlockOf),
            distinctUntilChanged(),
            switchMap((requestBlockNumber) =>
                requestBlockNumber !== undefined
                    ? new Observable<UnprocessedProofRequestStateNodeUnion>((subscriber) => {
                          const unprocessed = createUnprocessedProofRequestStateMachine(
                              Number(requestBlockNumber),
                              connections.nori,
                          )
                              .close()
                              .start('WaitingForEthFinality');
                          const subscription = unprocessed.state$.subscribe(subscriber);
                          return () => {
                              subscription.unsubscribe();
                              unprocessed.stop();
                          };
                      })
                    : of(undefined),
            ),
            shareReplay({ bufferSize: 1, refCount: true }),
        );
        const proof = {
            request$,
            progress$,
            retry: () => proofRequest.retry(),
            close: () => proofRequest.close(),
        };
        this.followed.set(txHash, proof);
        return proof;
    }

    /**
     * Closes every followed proof request with the app.
     * @returns {void}
     */
    onDestroy(): void {
        for (const { close } of this.followed.values()) close();
        this.followed.clear();
    }
}
