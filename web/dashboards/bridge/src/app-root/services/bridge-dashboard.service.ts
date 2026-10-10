import { Injectable } from '@yaw-rx/core';
import {
    BehaviorSubject,
    combineLatest,
    distinctUntilChanged,
    filter,
    interval,
    map,
    Observable,
    of,
    shareReplay,
    startWith,
    switchMap,
} from 'rxjs';
import { getAddress } from 'ethers';
import {
    arrived,
    createBridgeStateMachine,
    createEthereumBlocksMachine,
    createProofQueueBatchesMachine,
    createProofQueueBatchRequestsMachine,
    EMPTY_PROOF_QUEUE_BATCHES_VIEW,
    type ProofQueueBatchesSources,
    type ProofQueueBatchesState,
    type ProofQueueBatchesView,
    type ProofQueueBatchRequestsState,
    type ShownProofQueueBatch,
} from '@nori-zk/nori-bridge-tempo-sdk';
import { ConnectionsService, NoriBridgeInfraService } from '@nori-zk/tempo-web-ui';
import { waitingRows, type WaitingRow } from '../utils/waiting-rows.js';
import { SYNTHETIC, syntheticRequests } from '../utils/synthetic-requests.js';

/** How many batches the dashboard shows. */
const BATCH_COUNT = 10;

/** The filter the page's URL holds: a contract address, `''` for every contract, or `undefined` when it is not an address. */
type Target = string | undefined;

/** The batches machine's state for the contract the page filters on (`''` for every contract). */
export interface FilteredBatches {
    target: string;
    state: ProofQueueBatchesState;
}

/**
 * The view a batches machine's state carries; the empty view once it is closed.
 *
 * @param state The batches machine's state.
 * @returns Its view.
 */
export const viewOf = (state: ProofQueueBatchesState): ProofQueueBatchesView =>
    'view' in state.data ? state.data.view : EMPTY_PROOF_QUEUE_BATCHES_VIEW;

/**
 * The contract `?target=` names, checksummed.
 *
 * @returns The address, `''` without a filter, or `undefined` when it is not an address.
 */
const targetFromUrl = (): Target => {
    const target = new URLSearchParams(window.location.search).get('target')?.trim() ?? '';
    if (target === '') return '';
    try {
        return getAddress(target);
    } catch {
        return undefined;
    }
};

/**
 * Runs a machine while its states are subscribed, and closes it when they no longer are.
 *
 * @param start Starts the machine.
 * @returns The machine's states.
 */
const whileSubscribed = <TState>(
    start: () => { state$: Observable<TState>; close: () => void },
): Observable<TState> =>
    new Observable<TState>((subscriber) => {
        const machine = start();
        const subscription = machine.state$.subscribe(subscriber);
        return () => {
            subscription.unsubscribe();
            machine.close();
        };
    });

/**
 * Everything the dashboard shows: the sdk's batches machine for the
 * contract the URL filters on (started again when the filter changes), the
 * rows of requests no batch covers yet by where they wait, and each opened
 * batch's requests, from the sdk's batch requests machine.
 */
@Injectable([ConnectionsService, NoriBridgeInfraService])
export class BridgeDashboardService {
    /** The filter: a contract, `''` for every contract, or `undefined` when `?target=` is not an address. */
    readonly target$ = new BehaviorSubject<Target>(targetFromUrl());
    /** The batches machine's states, or `undefined` while the filter is not an address. */
    readonly batches$: Observable<FilteredBatches | undefined>;
    /**
     * The requests no batch covers yet, as rows by where they wait: for
     * Ethereum finality, scheduled for processing, and in the job Nori is
     * processing. Built again each second, and on every new view or Nori state.
     */
    readonly waitingRows$: Observable<WaitingRow[]>;
    /** The bridge's state and Ethereum's blocks, which every batches view reads from. */
    private readonly sources: ProofQueueBatchesSources;
    private readonly onPopState = (): void => this.target$.next(targetFromUrl());

    /**
     * @param connections The connections, and the queue and bridge addresses.
     * @param noriBridgeInfra Nori's bridge state.
     */
    constructor(
        private readonly connections: ConnectionsService,
        noriBridgeInfra: NoriBridgeInfraService,
    ) {
        const { connections: all, options } = connections;
        this.sources = {
            bridgeState: createBridgeStateMachine(all, options.proofRequests.bridgeAddress),
            ethereumBlocks: createEthereumBlocksMachine(all),
        };
        const { sources } = this;
        this.batches$ = this.target$.pipe(
            switchMap((target) =>
                target === undefined
                    ? of(undefined)
                    : whileSubscribed(() =>
                          createProofQueueBatchesMachine(
                              all,
                              options.proofRequests,
                              {
                                  target: target === '' ? undefined : target,
                                  fromBlock: NORI_WEB_ENV.ethereum.proofQueueDeployBlock,
                                  count: BATCH_COUNT,
                              },
                              sources,
                              noriBridgeInfra.stage$,
                          ),
                      ).pipe(map((state): FilteredBatches => ({ target, state }))),
            ),
            shareReplay({ bufferSize: 1, refCount: false }),
        );
        // Stamped by the sdk as they arrive, so a replay keeps the time they were sent.
        const bridge$ = noriBridgeInfra.state$;
        const finality$ = noriBridgeInfra.finality$;
        /** A Nori stream while its websocket is open, `undefined` otherwise. */
        const whileOpen = <T>(source$: Observable<T>): Observable<T | undefined> =>
            noriBridgeInfra.open$.pipe(
                switchMap((open) => (open ? source$.pipe(startWith(undefined)) : of(undefined))),
            );
        this.waitingRows$ = combineLatest([
            arrived(
                this.batches$.pipe(
                    filter((batches): batches is FilteredBatches => batches !== undefined),
                    map(({ state }) => viewOf(state)),
                    distinctUntilChanged(),
                ),
            ),
            whileOpen(bridge$),
            whileOpen(noriBridgeInfra.timings$),
            whileOpen(finality$),
            interval(1000).pipe(startWith(0)),
        ]).pipe(
            map(([view, bridge, timings, finality]) =>
                waitingRows({
                    // TEMPORARY: `?synthetic` adds synthetic requests to preview populated rows.
                    view: SYNTHETIC
                        ? {
                              ...view,
                              value: {
                                  ...view.value,
                                  waiting: [
                                      ...view.value.waiting,
                                      ...syntheticRequests(
                                          view.value.finalizedBlock,
                                          bridge?.value,
                                      ),
                                  ],
                              },
                          }
                        : view,
                    bridge,
                    timings,
                    finality,
                    nowMs: Date.now(),
                }),
            ),
            shareReplay({ bufferSize: 1, refCount: true }),
        );
        window.addEventListener('popstate', this.onPopState);
    }

    /**
     * Filters on a contract, or shows every contract for `''`, and writes it to `?target=`.
     *
     * @param target The contract's address, or `''`.
     */
    filter(target: string): void {
        const url = new URL(window.location.href);
        if (target.trim() === '') url.searchParams.delete('target');
        else url.searchParams.set('target', target.trim());
        window.history.pushState(null, '', url);
        this.target$.next(targetFromUrl());
    }

    /**
     * A batch's requests (only the filtered contract's when there is a
     * filter), from the sdk's batch requests machine, which runs while they
     * are subscribed.
     *
     * @param batch The batch.
     * @param target The contract, or `''` for every contract.
     * @returns The machine's states.
     */
    batchRequests$(
        batch: ShownProofQueueBatch,
        target: string,
    ): Observable<ProofQueueBatchRequestsState> {
        const { connections: all, options } = this.connections;
        return whileSubscribed(() =>
            createProofQueueBatchRequestsMachine(
                all,
                options.proofRequests.proofQueueAddress,
                batch,
                {
                    target: target === '' ? undefined : target,
                    fromBlock: NORI_WEB_ENV.ethereum.proofQueueDeployBlock,
                },
            ),
        );
    }

    /**
     * Stops listening for back and forward, and closes the bridge state and
     * Ethereum blocks machines.
     * @returns {void}
     */
    onDestroy(): void {
        window.removeEventListener('popstate', this.onPopState);
        this.sources.bridgeState.close();
        this.sources.ethereumBlocks.close();
    }
}
