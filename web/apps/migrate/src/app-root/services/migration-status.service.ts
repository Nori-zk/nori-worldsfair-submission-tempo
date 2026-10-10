import { Injectable } from '@yaw-rx/core';
import {
    catchError,
    exhaustMap,
    from,
    map,
    merge,
    type Observable,
    of,
    scan,
    shareReplay,
    startWith,
    Subject,
    switchMap,
    timer,
} from 'rxjs';
import { Contract, ZeroHash } from 'ethers';
import {
    type EthereumProvider,
    forCalls,
    getErc20TotalMinted,
    getMirror,
    getTokenBalance,
    getTokenPaused,
} from '@nori-zk/nori-bridge-tempo-sdk';
import { NoriTokenBridge__factory } from '@nori-zk/ethereum-tempo-bridge';
import { ITIP20__factory } from '@nori-zk/tempo-token-bridge';
import { ConnectionsService } from '@nori-zk/tempo-web-ui';
import { MIGRATE_ADDRESSES, MigrateService } from './migrate.service.js';

/** How often the status is read again. */
const STATUS_INTERVAL_MS = 15_000;

/** The ERC-20 calls the status makes. */
const ERC20_ABI = [
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function balanceOf(address) view returns (uint256)',
    'function paused() view returns (bool)',
];

/** The ERC-20's mirror on Tempo, once one is registered. */
export interface MirrorStatus {
    /** The TIP-20's address. */
    address: string;
    /** Whether the issuer keeps its admin (adopted), or the bridge holds it (created). */
    issuerOwned: boolean;
    /** Whether it is paused on Tempo. */
    paused: boolean;
    /** What the bridge minted, to everyone, in TIP-20 units. */
    minted: bigint;
    /** The recipient's balance, in TIP-20 units. */
    recipientBalance: bigint;
}

/** The migration on both chains, as last read. */
export interface MigrationStatus {
    symbol: string;
    /** The ERC-20's decimals on Ethereum; its TIP-20 has 6. */
    decimals: number;
    /** Whether the ERC-20 is paused on Ethereum. */
    paused: boolean;
    /** Locked in the token bridge, to everyone, in TIP-20 units (bridge units). */
    locked: bigint;
    /** The owner's ERC-20 balance, in its own units. */
    ownerBalance: bigint;
    /** The mirror, or `undefined` while none is registered. */
    mirror: MirrorStatus | undefined;
}

/** Who the status reads balances for. */
interface Holders {
    owner: string;
    recipient: string;
}

/**
 * Reads the ERC-20 on Ethereum: its pause, what is locked and the owner's balance.
 *
 * @param provider The Ethereum provider reads go through.
 * @param owner The wallet's account.
 * @returns The Ethereum half of the status.
 */
async function readEthereum(
    provider: EthereumProvider,
    owner: string,
): Promise<Omit<MigrationStatus, 'mirror'>> {
    const token = new Contract(MIGRATE_ADDRESSES.ethToken, ERC20_ABI, provider);
    const bridge = NoriTokenBridge__factory.connect(MIGRATE_ADDRESSES.tokenBridge, provider);
    const [symbol, decimals, paused, locked, ownerBalance] = await Promise.all([
        token.getFunction('symbol')() as Promise<string>,
        token.getFunction('decimals')() as Promise<bigint>,
        token.getFunction('paused')() as Promise<boolean>,
        bridge.totalLockedERC20BU(MIGRATE_ADDRESSES.ethToken),
        owner ? (token.getFunction('balanceOf')(owner) as Promise<bigint>) : Promise.resolve(0n),
    ]);
    return { symbol, decimals: Number(decimals), paused, locked, ownerBalance };
}

/**
 * Whether the bridge holds a TIP-20's admin role: true for a mirror it
 * created, false for the issuer's own, adopted.
 *
 * @param provider The Tempo provider reads go through.
 * @param tip20 The TIP-20.
 * @returns Whether the bridge is its admin.
 */
async function bridgeIsAdmin(provider: EthereumProvider, tip20: string): Promise<boolean> {
    return ITIP20__factory.connect(tip20, provider).hasRole(
        MIGRATE_ADDRESSES.tempoBridge,
        ZeroHash,
    );
}

/**
 * Reads the migration on both chains through the sdk's connections.
 *
 * @param connections The connections.
 * @param holders The owner and the recipient.
 * @returns The status.
 */
async function readStatus(
    connections: ConnectionsService['connections'],
    { owner, recipient }: Holders,
): Promise<MigrationStatus> {
    const { ethereum, tempo } = connections;
    const [ethereumStatus, mirrorAddress] = await Promise.all([
        forCalls(ethereum, readEthereum, owner),
        getMirror(tempo, MIGRATE_ADDRESSES.tempoBridge, MIGRATE_ADDRESSES.ethToken),
    ]);
    if (mirrorAddress === undefined) return { ...ethereumStatus, mirror: undefined };
    const [paused, minted, recipientBalance, adminIsBridge] = await Promise.all([
        getTokenPaused(tempo, mirrorAddress),
        getErc20TotalMinted(tempo, MIGRATE_ADDRESSES.tempoBridge, MIGRATE_ADDRESSES.ethToken),
        recipient ? getTokenBalance(tempo, mirrorAddress, recipient) : Promise.resolve(0n),
        forCalls(tempo, bridgeIsAdmin, mirrorAddress),
    ]);
    return {
        ...ethereumStatus,
        mirror: {
            address: mirrorAddress,
            issuerOwned: !adminIsBridge,
            paused,
            minted,
            recipientBalance,
        },
    };
}

/**
 * The migration on both chains, read every interval, after each step of the
 * migrate machine and on `refresh()`: the ERC-20's pause and what is locked
 * on Ethereum, the TIP-20's pause and what is minted on Tempo. A read that
 * fails keeps the last status.
 */
@Injectable([ConnectionsService, MigrateService])
export class MigrationStatusService {
    private readonly refresh$ = new Subject<void>();
    /** The latest status, or `undefined` before the first read. */
    readonly status$: Observable<MigrationStatus | undefined>;

    /**
     * @param connections The connections.
     * @param migrate The migrate machine, whose owner and recipient the balances are read for.
     */
    constructor(connections: ConnectionsService, migrate: MigrateService) {
        const holders$: Observable<Holders> = migrate.state$.pipe(
            map(({ data }) => ({ owner: data.owner, recipient: data.recipient })),
            startWith({ owner: '', recipient: '' }),
        );
        this.status$ = holders$.pipe(
            switchMap((holders) =>
                merge(timer(0, STATUS_INTERVAL_MS), this.refresh$, migrate.state$).pipe(
                    exhaustMap(() =>
                        from(readStatus(connections.connections, holders)).pipe(
                            catchError(() => of(undefined)),
                        ),
                    ),
                ),
            ),
            // A failed read (undefined) keeps the last status shown
            scan(
                (last: MigrationStatus | undefined, status: MigrationStatus | undefined) =>
                    status ?? last,
                undefined,
            ),
            shareReplay({ bufferSize: 1, refCount: true }),
        );
    }

    /**
     * Reads the status again now.
     * @returns {void}
     */
    refresh(): void {
        this.refresh$.next();
    }
}
