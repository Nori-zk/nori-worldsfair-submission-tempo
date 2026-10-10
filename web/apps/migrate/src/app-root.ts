import { Component, RxElement } from '@yaw-rx/core';
import {
    ConnectionsService,
    NoriBridgeInfraService,
    PROOF_REQUEST_CONNECTIONS_OPTIONS,
    ProofProgressService,
    type ConnectionsOptions,
} from '@nori-zk/tempo-web-ui';
import { MigrateService } from './app-root/services/migrate.service.js';
import { MigrationStatusService } from './app-root/services/migration-status.service.js';
import './app-root/components/migrate-form.component.js';
import './app-root/components/migration-status.component.js';

/** The chains, Nori websocket, queue and bridge this build reads, from `web/.env`. */
const connectionsOptions: ConnectionsOptions = {
    ethereum: {
        expectedChainId: BigInt(NORI_WEB_ENV.ethereum.chainId),
        http: { rpcUrl: NORI_WEB_ENV.ethereum.rpcUrl },
        wallet: true,
        // The public RPC first: reads go on while the wallet is on Tempo for a claim
        order: { calls: ['http', 'wallet'], logs: ['http', 'wallet'] },
    },
    tempo: {
        expectedChainId: BigInt(NORI_WEB_ENV.tempo.chainId),
        http: { rpcUrl: NORI_WEB_ENV.tempo.rpcUrl },
        websocket: { url: NORI_WEB_ENV.tempo.wssUrl },
        // The claim is the recipient's own Tempo transaction
        wallet: true,
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
        ProofProgressService,
        MigrateService,
        MigrationStatusService,
    ],
    template: `
        <nori-page
            heading="Migrate to Tempo"
            lede="Lock an ERC-20 on Ethereum, claim its TIP-20 on Tempo. Nori proves the lock, and the token's pause, with no signer in between."
        >
            <wallet-pair></wallet-pair>
            <migration-status></migration-status>
            <migrate-form></migrate-form>
        </nori-page>
    `,
})
export class AppRoot extends RxElement {}
