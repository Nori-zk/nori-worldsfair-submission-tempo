import { catchError, defer, forkJoin, map, merge, of, switchMap, throwError, timer } from 'rxjs';
import {
    changesOf$,
    createChainChangesMachine,
    startReadThroughConnectionsMachine,
    type ProofRequestConnections,
} from '@nori-zk/nori-bridge-tempo-sdk';
import { Backstop__factory, IGuardedToken__factory } from '@nori-zk/tempo-backstop';
import { GuardGraph, type GuardView } from './guard.js';
import { contractErrorName } from './tempo.js';

/** The Backstop's error for a guard that does not exist. */
const NO_GUARD = 'NoGuard';

/**
 * Starts reading one guard from the Backstop through the Tempo connection:
 * its id, its state, its status and its token's supply.
 *
 * @param connections The Ethereum and Tempo chains, from `createConnections`.
 * @param backstopAddress The Backstop on Tempo.
 * @param token The guarded TIP-20.
 * @param admin The guard's admin, the keeper's Tempo address.
 * @param pollIntervalMs How often to read again besides each Backstop log, as the status moves with time.
 * @returns The running machine; `current` carries `guardId` and `guard`. Its controls:
 *   - `retry()`: reads again now, without waiting, while failed.
 *   - `close()`: moves the machine to `closed`.
 */
export const createGuardMachine = (
    connections: ProofRequestConnections,
    backstopAddress: string,
    token: string,
    admin: string,
    pollIntervalMs: number
) => {
    const backstopLogs = createChainChangesMachine(connections.tempo, { address: backstopAddress });
    return startReadThroughConnectionsMachine(GuardGraph, {
        connections,
        read: (clients) =>
            clients.tempo((provider) => {
                const backstop = Backstop__factory.connect(backstopAddress, provider);
                return defer(() => backstop.guardIdOf(token, admin)).pipe(
                    switchMap((guardId) =>
                        defer(() => backstop.guard(guardId)).pipe(
                            switchMap((guard) =>
                                forkJoin([
                                    defer(() => backstop.status(guardId)),
                                    defer(() => IGuardedToken__factory.connect(token, provider).totalSupply()),
                                ]).pipe(
                                    map(([status, supply]): { guardId: string; guard: GuardView } => ({
                                        guardId,
                                        guard: {
                                            backing: guard.backing,
                                            backingEthBlock: guard.backingEthBlock,
                                            paused: guard.paused,
                                            tripped: guard.tripped,
                                            tripEthBlock: guard.tripEthBlock,
                                            tripDeficit: guard.tripDeficit,
                                            status,
                                            supply,
                                        },
                                    }))
                                )
                            ),
                            // A guard that does not exist is a value, not a failure.
                            catchError((error: unknown) =>
                                contractErrorName(error, backstop.interface) === NO_GUARD
                                    ? of({ guardId, guard: undefined })
                                    : throwError(() => error)
                            )
                        )
                    )
                );
            }),
        refreshOn: () => merge(changesOf$(backstopLogs), timer(pollIntervalMs)),
        needs: ['tempo'],
        owns: [backstopLogs],
    });
};
