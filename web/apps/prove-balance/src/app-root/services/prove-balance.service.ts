import { Injectable } from '@yaw-rx/core';
import { filter, map, type Observable, take } from 'rxjs';
import { NoWalletConfiguredError } from '@nori-zk/nori-bridge-tempo-sdk';
import { ConnectionsService } from '@nori-zk/tempo-web-ui';
import {
    type BalanceRequest,
    createProveBalanceMachine,
    type ProveBalanceMachine,
    requestOf,
} from '../machines/prove-balance.impl.js';
import type { ProveBalanceState } from '../machines/prove-balance.js';

/**
 * Runs the prove balance flow for the app's lifetime, from the start: it
 * waits in `noAccount` until the wallet shares an account.
 */
@Injectable([ConnectionsService])
export class ProveBalanceService {
    /** The running flow. */
    readonly machine: ProveBalanceMachine;

    /**
     * @param connections The connections, the wallet and its account.
     * @throws {NoWalletConfiguredError} When the app's connections have no wallet.
     */
    constructor(connections: ConnectionsService) {
        const { account } = connections.wallet;
        if (account === undefined) throw new NoWalletConfiguredError();
        this.machine = createProveBalanceMachine(
            connections.connections,
            account,
            NORI_WEB_ENV.ethereum.snapshotAddress,
        );
    }

    /** The flow's states. */
    get state$(): Observable<ProveBalanceState> {
        return this.machine.state$;
    }

    /**
     * Edits the request the flow holds.
     *
     * @param change The new request, from the current one.
     * @returns {void}
     */
    edit(change: (request: BalanceRequest) => BalanceRequest): void {
        this.state$
            .pipe(
                take(1),
                map(requestOf),
                filter((request): request is BalanceRequest => request !== undefined),
            )
            .subscribe((request) => this.machine.edit(change(request)));
    }

    /**
     * Closes the flow with the app.
     * @returns {void}
     */
    onDestroy(): void {
        this.machine.close();
        this.machine.stop();
    }
}
