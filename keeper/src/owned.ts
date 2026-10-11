import { filter, type Observable, take } from 'rxjs';
import { type MachineStatus } from '@yaw-rx/ystate';

/**
 * Runs `close` once a flow ends: at a terminal node, at `closed`, or stopped.
 * A flow's creator closes the machines it created for the flow this way.
 *
 * @param flow The running flow.
 * @param close Closes what the creator made for it.
 * @returns The subscription.
 */
export const closeWhenEnded = (flow: { status$: Observable<MachineStatus> }, close: () => void) =>
    flow.status$
        .pipe(
            filter((status) => status !== 'running'),
            take(1)
        )
        .subscribe(close);
