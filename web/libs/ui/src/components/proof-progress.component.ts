import { Component, Inject, RxElement, state } from '@yaw-rx/core';
import { RxIf } from '@yaw-rx/core/directives/rx-if';
import { distinctUntilChanged, filter, map, type Observable, switchMap } from 'rxjs';
import {
    ProofRequestState,
    type ProofRequestStateNodeUnion,
    type UnprocessedProofRequestStateNodeUnion,
} from '@nori-zk/nori-bridge-tempo-sdk';
import { type FollowedProof, ProofProgressService } from '../services/proof-progress.service.js';
import styles from './proof-progress.component.css';

/**
 * The status line for each node of the proof request machine: where the
 * request is. Every node but `proofAvailable`, `closed` and the two where
 * its transaction ended without enqueuing it (`transactionReplaced`,
 * `transactionDropped`) holds the snapshot last read; while a connection is
 * down or a read fails the machine reads again by itself, and the pins
 * show the connections.
 *
 * @param request The proof request machine's state.
 * @returns The status.
 */
const requestStatus = (request: ProofRequestStateNodeUnion): string => {
    if (request.node === 'proofAvailable')
        return `Proven on Tempo in batch #${request.data.snapshot.proofQueueBatchIndex.toString()}`;
    if (request.node === 'closed') return 'Stopped';
    if (request.node === 'transactionReplaced')
        return 'The transaction was replaced in your wallet before it enqueued a proof request';
    if (request.node === 'transactionDropped') return 'The transaction was dropped before it enqueued a proof request';
    const { snapshot } = request.data;
    return snapshot.state === ProofRequestState.Unprocessed
        ? `Request #${snapshot.requestId.toString()} is waiting for the bridge`
        : 'Finding the proof request on Ethereum';
};

/**
 * The fill of the progress bar for a node of the unprocessed machine: the
 * time spent in it over the time it is expected to take.
 *
 * @param progress The unprocessed machine's state.
 * @returns The fill, from 0 to 1.
 */
const progressFill = (progress: UnprocessedProofRequestStateNodeUnion): number => {
    if (progress.node === 'FinishedWaiting') return 1;
    const { elapsed_sec, time_remaining_sec } = progress.data;
    const total = elapsed_sec + time_remaining_sec;
    return Number.isFinite(total) && total > 0 ? Math.min(1, elapsed_sec / total) : 0;
};

/**
 * The detail under the bar for a node of the unprocessed machine: the
 * bridge's stage while the job that includes the request runs, and the time
 * left.
 *
 * @param progress The unprocessed machine's state.
 * @returns The detail.
 */
const progressDetail = (progress: UnprocessedProofRequestStateNodeUnion): string => {
    if (progress.node === 'FinishedWaiting') return 'Confirming on Tempo';
    const { stage_name, time_remaining_sec } = progress.data;
    const left = Number.isFinite(time_remaining_sec)
        ? ` · about ${Math.max(0, Math.round(time_remaining_sec)).toString()}s left`
        : '';
    return progress.node === 'WaitingForCurrentJobCompletion'
        ? `${stage_name}${left}`
        : left.slice(3);
};

/**
 * Follows one proof request from the transaction that enqueued it until a
 * committed batch on Tempo covers it. The status follows the proof request
 * machine; while the request is `unprocessed`, a bar follows the bridge's
 * progress on it from the websocket.
 */
@Component({
    selector: 'proof-progress',
    directives: [RxIf],
    template: `
        <p class="status">{{ status }}</p>
        <div rx-if="processing">
            <div rx-if="timed">
                <div class="bar"><div class="fill" [style]="fill"></div></div>
            </div>
            <ol class="stages">
                <li [class.current]="atFinality">Ethereum finality</li>
                <li [class.current]="atPrevious">Previous batch</li>
                <li [class.current]="atCurrent">Proving</li>
                <li [class.current]="atFinished">Tempo</li>
            </ol>
            <p class="detail">{{ detail }}</p>
        </div>
    `,
    styles,
})
export class ProofProgress extends RxElement {
    @Inject(ProofProgressService) private readonly proofProgress!: ProofProgressService;
    /** The transaction that enqueued the proof request. */
    @state txHash = '';

    /** The followed proof request, once the transaction hash is set. */
    private get followed$(): Observable<FollowedProof> {
        return this.txHash$.pipe(
            filter((txHash) => txHash !== ''),
            distinctUntilChanged(),
            map((txHash) => this.proofProgress.follow(txHash)),
        );
    }

    private get request$(): Observable<ProofRequestStateNodeUnion> {
        return this.followed$.pipe(switchMap(({ request$ }) => request$));
    }

    /** The unprocessed machine's state while the request is `unprocessed`, else `undefined`. */
    private get progress$(): Observable<UnprocessedProofRequestStateNodeUnion | undefined> {
        return this.followed$.pipe(switchMap(({ progress$ }) => progress$));
    }

    get status$(): Observable<string> {
        return this.request$.pipe(map(requestStatus));
    }

    get processing$(): Observable<boolean> {
        return this.progress$.pipe(map((progress) => progress !== undefined));
    }

    /** Whether the bar's fill is known: the bridge has sent timings, or the wait is over. */
    get timed$(): Observable<boolean> {
        return this.progress$.pipe(
            map(
                (progress) =>
                    progress !== undefined &&
                    (progress.node === 'FinishedWaiting' ||
                        Number.isFinite(progress.data.elapsed_sec + progress.data.time_remaining_sec)),
            ),
            distinctUntilChanged(),
        );
    }

    get fill$(): Observable<string> {
        return this.progress$.pipe(
            map((progress) =>
                progress === undefined
                    ? ''
                    : `width: ${(progressFill(progress) * 100).toFixed(1)}%`,
            ),
        );
    }

    get detail$(): Observable<string> {
        return this.progress$.pipe(
            map((progress) => (progress === undefined ? '' : progressDetail(progress))),
        );
    }

    get atFinality$(): Observable<boolean> {
        return this.progress$.pipe(map((progress) => progress?.node === 'WaitingForEthFinality'));
    }

    get atPrevious$(): Observable<boolean> {
        return this.progress$.pipe(
            map((progress) => progress?.node === 'WaitingForPreviousJobCompletion'),
        );
    }

    get atCurrent$(): Observable<boolean> {
        return this.progress$.pipe(
            map((progress) => progress?.node === 'WaitingForCurrentJobCompletion'),
        );
    }

    get atFinished$(): Observable<boolean> {
        return this.progress$.pipe(map((progress) => progress?.node === 'FinishedWaiting'));
    }
}
