import { Component } from '@yaw-rx/core';
import { map, type Observable } from 'rxjs';
import type { EthereumHealth, HttpConnectionState } from '@nori-zk/nori-bridge-tempo-sdk';
import { tempoLogo } from '../../brand/brand.js';
import { ChainButton } from './chain-button.component.js';

/**
 * A block number shortened for display: its last four digits.
 *
 * @param blockNumber The block number.
 * @returns The shortened block number.
 */
const shortBlock = (blockNumber: number): string => `…${blockNumber.toString().slice(-4)}`;

/**
 * The button's text for each node of Tempo's http connection machine.
 *
 * @param network The Tempo network the apps read.
 * @param state Tempo's http connection machine's state.
 * @returns The text for the button.
 */
const tempoText = (network: string, state: HttpConnectionState<EthereumHealth>): string => {
    switch (state.node) {
        case 'checking':
            return 'Connecting to Tempo';
        case 'ready':
            return `Tempo ${network}: ${shortBlock(state.data.health.blockNumber)}`;
        case 'wrongNetwork':
        case 'unreachable':
            return 'Reconnecting to Tempo';
        case 'offline':
            return 'Offline';
        case 'closed':
            return 'Closed';
    }
};

/**
 * The Tempo side of the wallet pair: the network its connection reads and
 * the latest block. Tempo reads need no wallet, so it shows the connection
 * only.
 */
@Component({
    selector: 'tempo-button',
    template: `
        <button [class.ready]="ready" disabled>
            <img class="logo" src="${tempoLogo}" alt="Tempo" />
            <span class="text">{{ text }}</span>
        </button>
    `,
})
export class TempoButton extends ChainButton {
    get text$(): Observable<string> {
        return this.connections.tempoHttpState$.pipe(
            map((state) => tempoText(this.connections.tempoNetwork, state)),
        );
    }

    get ready$(): Observable<boolean> {
        return this.connections.tempoHttpState$.pipe(map((state) => state.node === 'ready'));
    }
}
