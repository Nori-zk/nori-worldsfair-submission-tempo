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

/**
 * The chains, Nori websocket, queue and bridge this build reads, from
 * `web/.env`. Ethereum reads go over its public RPC before the wallet, so
 * they go on while the wallet is on Tempo for a claim; the wallet signs on
 * both chains, the lock on Ethereum and the claim on Tempo.
 */
const connectionsOptions: ConnectionsOptions = {
    ethereum: {
        expectedChainId: BigInt(NORI_WEB_ENV.ethereum.chainId),
        http: { rpcUrl: NORI_WEB_ENV.ethereum.rpcUrl },
        wallet: true,
        order: { calls: ['http', 'wallet'], logs: ['http', 'wallet'] },
    },
    tempo: {
        expectedChainId: BigInt(NORI_WEB_ENV.tempo.chainId),
        http: { rpcUrl: NORI_WEB_ENV.tempo.rpcUrl },
        websocket: { url: NORI_WEB_ENV.tempo.wssUrl },
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
            heading="Migrate"
            lede="Move an Ethereum ERC-20 to its issuer's TIP-20 on Tempo: lock it on Ethereum, claim it on Tempo once Nori has proven the lock."
        >
            <wallet-pair></wallet-pair>
            <migrate-form></migrate-form>
            <migration-status></migration-status>
        </nori-page>
    `,
})
export class AppRoot extends RxElement {}
