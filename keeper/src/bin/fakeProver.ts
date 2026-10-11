#!/usr/bin/env node
// LOCAL DRY RUN ONLY. Stands in for the Nori prover on a local Tempo node
// (`anvil --network tempo`): writes a proof queue batch covering every new
// queue request into the Nori bridge's storage, laid out as `update` writes
// it, with anvil's anvil_setStorageAt cheatcode, and emits the events
// `update` emits (`ProofQueueBatchCommitted`, `UpdateApplied`) from the
// bridge's address. It proves nothing.
import {
    AbiCoder,
    JsonRpcProvider,
    keccak256,
    toBeHex,
    zeroPadValue,
} from 'ethers';
import { NoriProofRequestQueue__factory } from '@nori-zk/ethereum-tempo-bridge';
import {
    MAX_U64,
    NoriTempoTokenBridge__factory,
    PACKED_STATE_OFFSETS,
    PACKED_STATE_SLOT,
    PROOF_QUEUE_BATCH_OFFSETS,
    PROOF_QUEUE_BATCHES_SLOT,
} from '@nori-zk/tempo-token-bridge';
import {
    request_batch_root,
    type RequestLeaf,
} from '@nori-zk/ethereum-tempo-proof-queue-utils-glam';
import { loadConfig, loadEnv } from '../keeper/config.js';

loadEnv();
const config = loadConfig(process.argv[2] ?? 'keeper.demo.json');
const { hostname } = new URL(config.tempo.rpcUrl);
if (!['127.0.0.1', 'localhost'].includes(hostname)) {
    console.error(
        `fake-prover only runs against a local Tempo node, not ${hostname}`
    );
    process.exit(1);
}
const provider = new JsonRpcProvider(config.ethereum.rpcUrl);
const tempo = new JsonRpcProvider(config.tempo.rpcUrl);
const bridgeAddress = config.tempo.bridge;

const word = (value: bigint) => toBeHex(value, 32);

async function setStorageAt(slot: bigint, value: string) {
    await tempo.send('anvil_setStorageAt', [bridgeAddress, word(slot), value]);
}

/** A log as the bridge emits it: its topics and its ABI-encoded data. */
interface BridgeLog {
    topics: string[];
    data: string;
}

/** Where the bridge's own code runs while the bridge's address holds `emittingCode`. */
const BRIDGE_CODE_ADDRESS = '0x00000000000000000000000000000000000b1d9e';

/** The test account the emitting transaction comes from: not the keeper's key, so their nonces never clash. */
const EMITTER_ACCOUNT_INDEX = 9;

/**
 * EVM code that, called with no calldata, emits `logs` in order from the
 * address it runs at and stops; called with any calldata, runs the bridge's
 * code at `BRIDGE_CODE_ADDRESS` by `DELEGATECALL` (the bridge's own storage
 * and address) and returns or reverts with its result. So everything that
 * reads or calls the bridge meanwhile sees the bridge.
 *
 * Each log's data is copied into memory a word at a time
 * (`PUSH32 word, PUSH2 offset, MSTORE`), then its topics, size and offset
 * are pushed for `LOG0`–`LOG4`.
 */
function emittingCode(logs: BridgeLog[]): string {
    const push2 = (value: number) => '61' + value.toString(16).padStart(4, '0');
    let emit = '5b'; // JUMPDEST
    for (const { topics, data } of logs) {
        const bytes = data.slice(2);
        const size = bytes.length / 2;
        for (let offset = 0; offset < size; offset += 32)
            emit += '7f' + bytes.slice(offset * 2, offset * 2 + 64).padEnd(64, '0') + push2(offset) + '52';
        for (const topic of [...topics].reverse()) emit += '7f' + topic.slice(2);
        emit += push2(size) + '6000' + (0xa0 + topics.length).toString(16);
    }
    emit += '00'; // STOP
    const delegate = (okAt: number) =>
        '3660006000' + '37' + // CALLDATACOPY(0, 0, CALLDATASIZE)
        '6000600036600073' + BRIDGE_CODE_ADDRESS.slice(2) + '5af4' + // DELEGATECALL(GAS, code, 0, CALLDATASIZE, 0, 0)
        '3d60006000' + '3e' + // RETURNDATACOPY(0, 0, RETURNDATASIZE)
        push2(okAt) + '57' + // JUMPI ok
        '3d6000fd'; // REVERT(0, RETURNDATASIZE)
    const ok = '5b3d6000f3'; // JUMPDEST, RETURN(0, RETURNDATASIZE)
    const head = (emitAt: number) => '3615' + push2(emitAt) + '57'; // no calldata: JUMPI emit
    const headBytes = head(0).length / 2;
    const okAt = headBytes + delegate(0).length / 2;
    const emitAt = okAt + ok.length / 2;
    return '0x' + head(emitAt) + delegate(okAt) + ok + emit;
}

/**
 * Emits `logs` from the bridge's address, as one transaction to it: the
 * bridge's code is copied to `BRIDGE_CODE_ADDRESS` and the bridge's own
 * swapped for `emittingCode` (anvil_setCode) for that transaction, then put
 * back. Its storage is untouched.
 */
async function emitFromBridge(logs: BridgeLog[]) {
    const bridgeCode = await tempo.getCode(bridgeAddress);
    await tempo.send('anvil_setCode', [BRIDGE_CODE_ADDRESS, bridgeCode]);
    await tempo.send('anvil_setCode', [bridgeAddress, emittingCode(logs)]);
    try {
        const from = ((await tempo.send('eth_accounts', [])) as string[])[EMITTER_ACCOUNT_INDEX];
        const hash = (await tempo.send('eth_sendTransaction', [{ from, to: bridgeAddress }])) as string;
        await tempo.waitForTransaction(hash);
    } finally {
        await tempo.send('anvil_setCode', [bridgeAddress, bridgeCode]);
    }
}

// The bridge's position, as `update` left it
const bridge = NoriTempoTokenBridge__factory.connect(bridgeAddress, tempo);
const bridgeInterface = NoriTempoTokenBridge__factory.createInterface();
const state = await bridge.state();
let cursor = state.queueCursor;
let batchCount = state.proofQueueBatchCount;
/** The batch this run commits, as `update` announces it; none when no request is new. */
let committed: BridgeLog | undefined;

const queue = NoriProofRequestQueue__factory.connect(
    config.ethereum.proofQueue,
    provider
);
const block = await provider.getBlockNumber();
const head = await queue.head({ blockTag: block });

if (head > cursor) {
    const leaves: RequestLeaf[] = [];
    for (let id = cursor; id < head; id++) {
        const request = await queue.requests(id, { blockTag: block });
        const count = Number(request.collectionKeysCount);
        leaves.push({
            target: request.target,
            collectionKeysCount: count,
            collectionKeys: [...request.collectionKeys].slice(0, count),
            value: zeroPadValue(
                await provider.getStorage(
                    request.target,
                    request.slotKey,
                    block
                ),
                32
            ),
        });
    }
    const base = BigInt(
        keccak256(
            AbiCoder.defaultAbiCoder().encode(
                ['uint64', 'uint256'],
                [batchCount, PROOF_QUEUE_BATCHES_SLOT]
            )
        )
    );
    const tempoBlockNumber = BigInt(await tempo.getBlockNumber());
    const root = request_batch_root({ leaves });
    committed = bridgeInterface.encodeEventLog('ProofQueueBatchCommitted', [
        batchCount,
        root,
        cursor,
        head,
        BigInt(block),
    ]);
    await setStorageAt(base, root);
    await setStorageAt(
        base + 1n,
        word(
            (BigInt(block) << PROOF_QUEUE_BATCH_OFFSETS.outputBlockNumber) |
                (cursor << PROOF_QUEUE_BATCH_OFFSETS.inputQueueCursor) |
                (head << PROOF_QUEUE_BATCH_OFFSETS.outputQueueCursor) |
                (tempoBlockNumber << PROOF_QUEUE_BATCH_OFFSETS.tempoBlockNumber)
        )
    );
    console.log(
        `batch ${batchCount}: requests [${cursor}, ${head}) at Ethereum block ${block}`
    );
    cursor = head;
    batchCount += 1n;
} else {
    console.log(`no new requests (cursor ${cursor})`);
}

// The packed state word: the new cursor and batch count, the head kept
const packed = BigInt(await tempo.getStorage(bridgeAddress, PACKED_STATE_SLOT));
const replaced =
    (MAX_U64 << PACKED_STATE_OFFSETS.queueCursor) |
    (MAX_U64 << PACKED_STATE_OFFSETS.proofQueueBatchCount);
await setStorageAt(
    PACKED_STATE_SLOT,
    word(
        (packed & ~replaced) |
            (cursor << PACKED_STATE_OFFSETS.queueCursor) |
            (batchCount << PACKED_STATE_OFFSETS.proofQueueBatchCount)
    )
);
// The events `update` emits: the committed batch, then the update itself
await emitFromBridge([
    ...(committed ? [committed] : []),
    bridgeInterface.encodeEventLog('UpdateApplied', [state.latestHead, cursor, state.verifiedStateRoot, batchCount]),
]);
console.log(
    `Nori bridge ${bridgeAddress}: cursor ${cursor}, ${batchCount} batches`
);
