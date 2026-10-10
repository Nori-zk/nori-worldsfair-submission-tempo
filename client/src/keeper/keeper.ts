import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isError, Wallet, type JsonRpcProvider } from 'ethers';
import { firstValueFrom } from 'rxjs';
import { NoriSnapshot__factory } from '@nori-zk/ethereum-snapshot';
import {
    bothReady$,
    createConnections,
    getBridgeState,
    getProofQueueHead,
    type Connections,
} from '@nori-zk/nori-bridge-tempo-sdk';
import {
    Backstop__factory,
    IGuardedToken__factory,
    ReadKind,
    type Backstop,
} from '@nori-zk/tempo-backstop';
import { guardStatusName } from '../backstop.js';
import {
    fetchProvenSnapshot,
    type ProvenSnapshot,
} from '../fetchProvenSnapshot.js';
import {
    guardConfigOf,
    queryOf,
    type GuardEntry,
    type KeeperConfig,
} from './config.js';
import {
    connectTempo,
    contractErrorName,
    createProvider,
    RPC_TIMEOUT_MS,
    type Tempo,
} from './tempo.js';
import { errorMessage, withTimeout } from './util.js';

/** How long `snapshot` waits for its transaction to be mined. */
const SNAPSHOT_WAIT_MS = 3 * 60_000;
/** The sdk's requests have no timeout of their own; a hung one would stall the loop. */
const PROVEN_SNAPSHOT_TIMEOUT_MS = 2 * 60_000;

// Backstop errors the keeper treats as "nothing to do"
const READ_NOT_NEWER = 'ReadNotNewer';
const CHECKPOINT_TOO_SOON = 'CheckpointTooSoon';
const NO_GUARD = 'NoGuard';

interface KeeperState {
    /** Snapshot transactions whose reads are not all submitted yet. */
    pending: string[];
}

export class Keeper {
    private constructor(
        private readonly config: KeeperConfig,
        private readonly tempo: Tempo,
        private readonly backstop: Backstop,
        private readonly provider: JsonRpcProvider,
        private readonly connections: Connections
    ) {}

    /** The keeper signs through its own clients and reads through the sdk's connections. */
    static async connect(config: KeeperConfig): Promise<Keeper> {
        const key = process.env.TEMPO_PRIVATE_KEY;
        if (!key) throw new Error('Missing env: TEMPO_PRIVATE_KEY');
        const tempo = connectTempo(config.tempo.rpcUrl, key);
        const provider = createProvider(config.ethereum.rpcUrl);
        const [{ chainId }, { chainId: tempoChainId }] = await Promise.all([
            provider.getNetwork(),
            tempo.provider.getNetwork(),
        ]);
        const connections = createConnections({
            network: config.network,
            ethereum: {
                expectedChainId: chainId,
                http: { rpcUrl: config.ethereum.rpcUrl },
            },
            tempo: {
                expectedChainId: tempoChainId,
                http: { rpcUrl: config.tempo.rpcUrl },
            },
        });
        await withTimeout(
            firstValueFrom(bothReady$(connections)),
            RPC_TIMEOUT_MS,
            'Ethereum and Tempo connections'
        );
        const backstop = Backstop__factory.connect(
            config.tempo.backstop,
            tempo.signer
        );
        return new Keeper(config, tempo, backstop, provider, connections);
    }

    private log(message: string) {
        console.log(`${new Date().toISOString()} ${message}`);
    }

    /** The Ethereum signer of snapshots. */
    private ethereumSigner(): Wallet {
        const key = process.env.ETH_PRIVATE_KEY;
        if (!key) throw new Error('Missing env: ETH_PRIVATE_KEY');
        return new Wallet(key, this.provider);
    }

    private guardId(guard: GuardEntry) {
        return this.backstop.guardIdOf(guard.token, this.tempo.signer.address);
    }

    /** The guard, or null when it does not exist. */
    private async readGuard(guardId: string) {
        try {
            return await this.backstop.guard(guardId);
        } catch (error) {
            if (contractErrorName(error, this.backstop.interface) === NO_GUARD)
                return null;
            throw error;
        }
    }

    private loadState(): KeeperState {
        return {
            pending: [],
            ...(existsSync(this.config.stateFile)
                ? (JSON.parse(
                      readFileSync(this.config.stateFile, 'utf8')
                  ) as Partial<KeeperState>)
                : {}),
        };
    }

    private saveState(state: KeeperState) {
        writeFileSync(
            this.config.stateFile,
            JSON.stringify(state, null, 2) + '\n'
        );
    }

    /** Creates each configured guard that does not exist yet; the keeper key is its admin. */
    async createGuards() {
        const { bridge } = this.config.tempo;
        if ((await this.tempo.provider.getCode(bridge)) === '0x')
            throw new Error(
                `No Nori bridge contract at ${bridge}; deploy it before creating guards`
            );
        for (const guard of this.config.guards) {
            const guardId = await this.guardId(guard);
            if (await this.readGuard(guardId)) {
                this.log(`${guard.name}: guard ${guardId} exists`);
                continue;
            }
            await this.tempo.send(
                this.backstop.createGuard(
                    guard.token,
                    guardConfigOf(this.config, guard)
                )
            );
            this.log(`${guard.name}: created guard ${guardId}`);
        }
    }

    /** One NoriSnapshot transaction covering every configured query. */
    async snapshot() {
        const snapshot = NoriSnapshot__factory.connect(
            this.config.ethereum.noriSnapshot,
            this.ethereumSigner()
        );
        const queries = new Map<string, { target: string; data: string }>();
        for (const guard of this.config.guards) {
            for (const query of [guard.backing, guard.pause]) {
                if (!query) continue;
                const { target, data, queryId } = queryOf(query);
                queries.set(queryId, { target, data });
            }
        }
        const fee = await snapshot.snapshotFee();
        const tx = await snapshot.snapshot([...queries.values()], {
            value: fee,
        });
        // Pending as soon as it is sent: a slow block can't lose it or stall the loop
        const state = this.loadState();
        state.pending.push(tx.hash);
        this.saveState(state);
        try {
            const receipt = await tx.wait(1, SNAPSHOT_WAIT_MS);
            this.log(
                `snapshot ${tx.hash}: ${queries.size} queries, block ${receipt?.blockNumber}`
            );
        } catch (error) {
            if (isError(error, 'CALL_EXCEPTION')) {
                // Reverted (e.g. the queue fee changed): it has no reads
                const current = this.loadState();
                this.saveState({
                    ...current,
                    pending: current.pending.filter((hash) => hash !== tx.hash),
                });
                throw new Error(`snapshot ${tx.hash} reverted`);
            }
            this.log(
                `snapshot ${tx.hash}: not mined after ${SNAPSHOT_WAIT_MS / 60_000} min; its reads go in once it is`
            );
        }
    }

    /** Records each guard's token supply (skips guards checkpointed too recently). */
    async checkpoint() {
        for (const guard of this.config.guards) {
            try {
                await this.tempo.send(
                    this.backstop.checkpoint(await this.guardId(guard))
                );
                this.log(`${guard.name}: checkpoint`);
            } catch (error) {
                if (
                    contractErrorName(error, this.backstop.interface) !==
                    CHECKPOINT_TOO_SOON
                )
                    this.log(
                        `${guard.name}: checkpoint failed: ${errorMessage(error)}`
                    );
            }
        }
    }

    /**
     * Submits every pending snapshot's reads whose batch is proven. A read the
     * contract rejects is logged and dropped; one that fails in transit is
     * retried next round. Neither blocks other guards or snapshots.
     */
    async submit(quiet = false) {
        const pending = this.loadState().pending;
        const stillPending: string[] = [];
        for (const snapshotTxHash of pending) {
            let done = false;
            try {
                done = await this.submitSnapshot(snapshotTxHash);
            } catch (error) {
                this.log(
                    `snapshot ${snapshotTxHash}: failed: ${errorMessage(error)}`
                );
            }
            if (done) this.log(`snapshot ${snapshotTxHash}: reads submitted`);
            else stillPending.push(snapshotTxHash);
        }
        // Keep what another keeper process (a CLI `snapshot`) added meanwhile
        const current = this.loadState();
        const added = current.pending.filter((hash) => !pending.includes(hash));
        this.saveState({ ...current, pending: [...stillPending, ...added] });
        if (stillPending.length && !quiet)
            this.log(
                `${stillPending.length} snapshot(s) pending: waiting for a proof or retrying`
            );
    }

    /** True once the snapshot is proven and every guard's reads are applied. */
    private async submitSnapshot(snapshotTxHash: string): Promise<boolean> {
        const snapshot = await withTimeout(
            fetchProvenSnapshot({
                connections: this.connections,
                noriSnapshot: this.config.ethereum.noriSnapshot,
                proofQueue: this.config.ethereum.proofQueue,
                snapshotTxHash,
                bridgeAddress: this.config.tempo.bridge,
            }),
            PROVEN_SNAPSHOT_TIMEOUT_MS,
            'reading the proof request'
        );
        if (!snapshot.proven) return false;
        let done = true;
        for (const guard of this.config.guards) {
            try {
                await this.submitGuardReads(guard, snapshot);
            } catch (error) {
                this.log(
                    `${guard.name}: snapshot ${snapshotTxHash} failed: ${errorMessage(error)}`
                );
                done = false;
            }
        }
        return done;
    }

    /** Applies the guard's backing and pause results (an already-applied read is skipped). */
    private async submitGuardReads(
        guard: GuardEntry,
        snapshot: Extract<ProvenSnapshot, { proven: true }>
    ) {
        const reads = [
            [ReadKind.Backing, guard.backing],
            [ReadKind.Pause, guard.pause],
        ] as const;
        for (const [kind, query] of reads) {
            if (!query) continue;
            try {
                await this.tempo.send(
                    this.backstop.submitRead(
                        await this.guardId(guard),
                        kind,
                        snapshot.proofQueueBatchIndex,
                        snapshot.witnessFor(queryOf(query).queryId)
                    )
                );
            } catch (error) {
                const name = contractErrorName(error, this.backstop.interface);
                // A contract error is final for this read; only transport errors retry
                if (name === undefined) throw error;
                if (name !== READ_NOT_NEWER)
                    this.log(`${guard.name}: read rejected (${name}), dropped`);
            }
        }
    }

    /**
     * Clears each tripped guard's latch (the keeper key must be its admin).
     * Unlatch after a proven read shows the backing restored, or the next
     * read trips it again.
     */
    async unlatch() {
        for (const guard of this.config.guards) {
            const guardId = await this.guardId(guard);
            const state = await this.readGuard(guardId);
            if (!state) {
                this.log(`${guard.name}: no guard ${guardId}`);
                continue;
            }
            if (!state.tripped) {
                this.log(`${guard.name}: not tripped`);
                continue;
            }
            await this.tempo.send(this.backstop.unlatch(guardId));
            this.log(
                `${guard.name}: unlatched (backing ${state.backing} at Ethereum block ${state.backingEthBlock})`
            );
        }
    }

    /** Prints Nori's progress through the proof queue, then each guard's status. */
    async status() {
        for (const line of await this.statusLines()) this.log(line);
    }

    private async statusLines(): Promise<string[]> {
        const lines: string[] = [];
        const { bridge } = this.config.tempo;
        const { ethereum, tempo } = this.connections;
        const [nori, requests] = await withTimeout(
            Promise.all([
                getBridgeState(tempo, bridge).catch((): null => null),
                getProofQueueHead(ethereum, this.config.ethereum.proofQueue),
            ]),
            RPC_TIMEOUT_MS,
            "reading Nori's progress"
        );
        if (nori) {
            lines.push(
                `nori: beacon slot ${nori.latestHead} | ${nori.queueCursor} of ${requests} queue requests proven` +
                    ` | ${nori.proofQueueBatchCount} batches | ${this.loadState().pending.length} snapshot(s) waiting`
            );
        } else {
            lines.push(`nori: no bridge state at ${bridge}`);
        }
        for (const guard of this.config.guards) {
            const guardId = await this.guardId(guard);
            const state = await this.readGuard(guardId);
            if (!state) {
                lines.push(`${guard.name}: no guard ${guardId}`);
                continue;
            }
            const [status, supply] = await Promise.all([
                this.backstop.status(guardId),
                IGuardedToken__factory.connect(
                    guard.token,
                    this.tempo.provider
                ).totalSupply(),
            ]);
            lines.push(
                `${guard.name}: ${guardStatusName(status)} | backing ${state.backing} | supply ${supply}` +
                    ` | Ethereum block ${state.backingEthBlock} | paused ${state.paused}` +
                    (state.tripped
                        ? ` | tripped at block ${state.tripEthBlock}, deficit ${state.tripDeficit}`
                        : '')
            );
        }
        return lines;
    }

    /**
     * Checkpoints, snapshots and submits on the configured intervals,
     * forever, and prints each status line when it changes. One job at a time, so jobs
     * never race on the state file.
     */
    async run() {
        const { snapshotSecs, checkpointSecs, pollSecs } =
            this.config.intervals;
        const last = { checkpoint: 0, snapshot: 0 };
        const shown = new Set<string>();
        for (;;) {
            const now = Date.now() / 1000;
            const jobs: Array<[string, () => Promise<void>]> = [];
            if (now - last.checkpoint >= checkpointSecs) {
                last.checkpoint = now;
                jobs.push(['checkpoint', () => this.checkpoint()]);
            }
            if (now - last.snapshot >= snapshotSecs) {
                // Only once sent: a failed snapshot retries next round
                jobs.push([
                    'snapshot',
                    async () => {
                        await this.snapshot();
                        last.snapshot = now;
                    },
                ]);
            }
            jobs.push(['submit', () => this.submit(true)]);
            for (const [name, job] of jobs) {
                try {
                    await job();
                } catch (error) {
                    this.log(`${name} failed: ${errorMessage(error)}`);
                }
            }
            try {
                const lines = await this.statusLines();
                for (const line of lines) if (!shown.has(line)) this.log(line);
                shown.clear();
                for (const line of lines) shown.add(line);
            } catch (error) {
                this.log(`status failed: ${errorMessage(error)}`);
            }
            await new Promise((resolve) =>
                setTimeout(resolve, pollSecs * 1000)
            );
        }
    }
}
