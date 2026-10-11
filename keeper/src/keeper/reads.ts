import { filter, finalize, map, type Observable, take } from 'rxjs';

/** A running machine, as far as reading its states and closing it go. */
export interface Running<TState> {
    state$: Observable<TState>;
    close(): void;
}

/**
 * Each `current` value a read machine holds, as it changes.
 *
 * @param machine A machine built on `readThroughConnectionsOf`.
 * @returns Its `current` data, each time it is current.
 */
export function currentData$<TState extends { node: string; data: unknown }>(
    machine: Running<TState>
): Observable<Extract<TState, { node: 'current' }>['data']> {
    return machine.state$.pipe(
        filter((state): state is Extract<TState, { node: 'current' }> => state.node === 'current'),
        map(({ data }) => data)
    );
}

/**
 * The first `current` value a read machine holds, for a one-off command;
 * the machine is closed once it is read.
 *
 * @param machine A machine built on `readThroughConnectionsOf`.
 * @returns Its `current` data, once.
 */
export function currentOf$<TState extends { node: string; data: unknown }>(
    machine: Running<TState>
): Observable<Extract<TState, { node: 'current' }>['data']> {
    return currentData$(machine).pipe(
        take(1),
        finalize(() => machine.close())
    );
}
