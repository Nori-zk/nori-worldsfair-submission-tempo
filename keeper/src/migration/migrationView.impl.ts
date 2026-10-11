import { Contract, sha256, ZeroAddress } from 'ethers';
import { defer, forkJoin, map, merge, of, switchMap } from 'rxjs';
import { NoriTokenBridge__factory } from '@nori-zk/ethereum-tempo-bridge';
import {
    changesOf$,
    createChainChangesMachine,
    startReadThroughConnectionsMachine,
    type ProofRequestConnections,
} from '@nori-zk/nori-bridge-tempo-sdk';
import { ITIP20__factory, NoriTempoTokenBridge__factory } from '@nori-zk/tempo-token-bridge';
import { MigrationGraph, type MigrationView } from './migrationView.js';

const ERC20_ABI = [
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function paused() view returns (bool)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
];

/**
 * `erc20TotalMinted` arrives in @nori-zk/tempo-token-bridge 0.0.3
 * (nori-tempo-sdk's issuer-owned mirrors); read through this fragment until
 * that is on npm.
 */
const TOTAL_MINTED_ABI = ['function erc20TotalMinted(address ethToken) view returns (uint64)'];

/**
 * The commitment a lock makes to its Tempo recipient: sha256 of its 20-byte address.
 *
 * @param recipient The Tempo address.
 * @returns The code challenge `lockERC20` takes.
 */
export const codeChallengeOf = (recipient: string): bigint => BigInt(sha256(recipient));

/** Where the migration is read: the ERC-20, both bridges, the holder on Ethereum and the recipient on Tempo. */
export interface MigrationAddresses {
    ethToken: string;
    tokenBridge: string;
    tempoBridge: string;
    holder: string;
    recipient: string;
}

/**
 * Starts reading one ERC-20's migration through both connections: the
 * ERC-20 and what the token bridge locked on Ethereum, its mirror and what
 * the Nori bridge minted on Tempo.
 *
 * @param connections The Ethereum and Tempo chains, from `createConnections`.
 * @param addresses The ERC-20, both bridges, the holder and the recipient.
 * @returns The running machine; `current` carries `migration`. Its controls:
 *   - `retry()`: reads again now, without waiting, while failed.
 *   - `close()`: moves the machine to `closed`.
 */
export const createMigrationMachine = (connections: ProofRequestConnections, addresses: MigrationAddresses) => {
    const { ethToken, tokenBridge, tempoBridge, holder, recipient } = addresses;
    const ethereumBlocks = createChainChangesMachine(connections.ethereum);
    const tempoBridgeLogs = createChainChangesMachine(connections.tempo, { address: tempoBridge });
    return startReadThroughConnectionsMachine(MigrationGraph, {
        connections,
        read: (clients) =>
            forkJoin([
                clients.ethereum((provider) => {
                    const token = new Contract(ethToken, ERC20_ABI, provider);
                    const bridge = NoriTokenBridge__factory.connect(tokenBridge, provider);
                    return forkJoin({
                        symbol: defer(() => token.symbol() as Promise<string>),
                        decimals: defer(() => token.decimals() as Promise<bigint>),
                        erc20Paused: defer(() => token.paused() as Promise<boolean>),
                        balance: defer(() => token.balanceOf(holder) as Promise<bigint>),
                        allowance: defer(() => token.allowance(holder, tokenBridge) as Promise<bigint>),
                        totalLocked: defer(() => bridge.totalLockedERC20BU(ethToken)),
                        lockedForRecipient: defer(() => bridge.lockedERC20(ethToken, codeChallengeOf(recipient))),
                    });
                }),
                clients.tempo((provider) => {
                    const bridge = NoriTempoTokenBridge__factory.connect(tempoBridge, provider);
                    return forkJoin({
                        totalMinted: defer(
                            () =>
                                new Contract(tempoBridge, TOTAL_MINTED_ABI, provider).erc20TotalMinted(
                                    ethToken
                                ) as Promise<bigint>
                        ),
                        mintedToRecipient: defer(() => bridge.erc20MintedSoFar(ethToken, recipient)),
                        mirror: defer(() => bridge.mirrorOf(ethToken)).pipe(
                            switchMap((mirror) =>
                                mirror === ZeroAddress
                                    ? of({ mirror: undefined, mirrorPaused: undefined, recipientBalance: 0n })
                                    : forkJoin({
                                          mirrorPaused: defer(() => ITIP20__factory.connect(mirror, provider).paused()),
                                          recipientBalance: defer(() =>
                                              ITIP20__factory.connect(mirror, provider).balanceOf(recipient)
                                          ),
                                      }).pipe(map((read) => ({ mirror, ...read })))
                            )
                        ),
                    });
                }),
            ]).pipe(
                map(([ethereum, { mirror, ...tempo }]): { migration: MigrationView } => ({
                    migration: { ...ethereum, ...tempo, ...mirror },
                }))
            ),
        refreshOn: () => merge(changesOf$(ethereumBlocks), changesOf$(tempoBridgeLogs)),
        owns: [ethereumBlocks, tempoBridgeLogs],
    });
};
