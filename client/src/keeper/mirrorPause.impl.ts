import { Contract, ZeroAddress } from 'ethers';
import { defer, forkJoin, map, merge, of, switchMap } from 'rxjs';
import { NoriTokenBridge__factory } from '@nori-zk/ethereum-tempo-bridge';
import {
    changesOf$,
    createChainChangesMachine,
    startReadThroughConnectionsMachine,
    type ProofRequestConnections,
} from '@nori-zk/nori-bridge-tempo-sdk';
import { ITIP20__factory, NoriTempoTokenBridge__factory } from '@nori-zk/tempo-token-bridge';
import { MirrorPauseGraph, type MirrorPauseView } from './mirrorPause.js';

const PAUSABLE_ABI = ['function paused() view returns (bool)'];

/** Where the pause state is read: the ERC-20, the token bridge on Ethereum, and the bridge on Tempo. */
export interface MirrorPauseAddresses {
    ethToken: string;
    tokenBridge: string;
    tempoBridge: string;
}

/**
 * Starts reading one mirrored ERC-20's pause state through both connections:
 * the ERC-20's `paused()` and the pause state the token bridge last synced
 * on Ethereum, and its mirror and the mirror's `paused()` on Tempo.
 *
 * @param connections The Ethereum and Tempo chains, from `createConnections`.
 * @param addresses The ERC-20 and both bridges.
 * @returns The running machine; `current` carries `pause`. Its controls:
 *   - `retry()`: reads again now, without waiting, while failed.
 *   - `close()`: moves the machine to `closed`.
 */
export const createMirrorPauseMachine = (connections: ProofRequestConnections, addresses: MirrorPauseAddresses) => {
    const ethereumBlocks = createChainChangesMachine(connections.ethereum);
    const tempoBridgeLogs = createChainChangesMachine(connections.tempo, { address: addresses.tempoBridge });
    return startReadThroughConnectionsMachine(MirrorPauseGraph, {
        connections,
        read: (clients) =>
            forkJoin([
                clients.ethereum((provider) =>
                    forkJoin([
                        defer(() => new Contract(addresses.ethToken, PAUSABLE_ABI, provider).paused() as Promise<boolean>),
                        defer(() =>
                            NoriTokenBridge__factory.connect(addresses.tokenBridge, provider).pauseState(addresses.ethToken)
                        ),
                    ])
                ),
                clients.tempo((provider) =>
                    defer(() =>
                        NoriTempoTokenBridge__factory.connect(addresses.tempoBridge, provider).mirrorOf(addresses.ethToken)
                    ).pipe(
                        switchMap((mirror) =>
                            mirror === ZeroAddress
                                ? of({ mirror: undefined, mirrorPaused: undefined })
                                : defer(() => ITIP20__factory.connect(mirror, provider).paused()).pipe(
                                      map((mirrorPaused) => ({ mirror, mirrorPaused }))
                                  )
                        )
                    )
                ),
            ]).pipe(
                map(([[erc20Paused, synced], tempo]): { pause: MirrorPauseView } => ({
                    pause: { erc20Paused, synced, ...tempo },
                }))
            ),
        refreshOn: () => merge(changesOf$(ethereumBlocks), changesOf$(tempoBridgeLogs)),
        owns: [ethereumBlocks, tempoBridgeLogs],
    });
};
