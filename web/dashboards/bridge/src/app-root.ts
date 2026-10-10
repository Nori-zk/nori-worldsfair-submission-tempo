import { Component, RxElement } from '@yaw-rx/core';
import {
    ConnectionsService,
    NoriBridgeInfraService,
    PROOF_REQUEST_CONNECTIONS_OPTIONS,
    type ConnectionsOptions,
} from '@nori-zk/tempo-web-ui';
import { BridgeDashboardService } from './app-root/services/bridge-dashboard.service.js';
import './app-root/components/batch-table.component.js';

/** The chains, bridge websocket, queue and bridge this build reads, from `web/.env`. */
const connectionsOptions: ConnectionsOptions = {
    ethereum: {
        expectedChainId: BigInt(NORI_WEB_ENV.ethereum.chainId),
        http: { rpcUrl: NORI_WEB_ENV.ethereum.rpcUrl },
        order: { calls: ['http'], logs: ['http'] },
    },
    tempo: {
        expectedChainId: BigInt(NORI_WEB_ENV.tempo.chainId),
        http: { rpcUrl: NORI_WEB_ENV.tempo.rpcUrl },
        websocket: { url: NORI_WEB_ENV.tempo.wssUrl },
    },
    nori: { websocket: { url: NORI_WEB_ENV.bridge.wssUrl } },
    proofRequests: {
        proofQueueAddress: NORI_WEB_ENV.ethereum.proofQueueAddress,
        bridgeAddress: NORI_WEB_ENV.tempo.bridgeAddress,
    },
};

@Component({
    selector: 'app-root',
    providers: [
        { provide: PROOF_REQUEST_CONNECTIONS_OPTIONS, useValue: connectionsOptions },
        ConnectionsService,
        NoriBridgeInfraService,
        BridgeDashboardService,
    ],
    template: `
        <nori-page
            heading="Bridge dashboard"
            lede="Every proof request a contract has submitted, from Ethereum to Tempo."
        >
            <batch-table></batch-table>
        </nori-page>
    `,
})
export class AppRoot extends RxElement {}
