#!/usr/bin/env node
// LOCAL DRY RUN ONLY. Stands in for the Nori prover on a local Tempo node
// (`anvil --network tempo`): writes a proof queue batch covering every new
// queue request into the Nori bridge's storage, laid out as `update` writes
// it, with anvil's anvil_setStorageAt cheatcode. It proves nothing.
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

// The bridge's position, as `update` left it
const bridge = NoriTempoTokenBridge__factory.connect(bridgeAddress, tempo);
const state = await bridge.state();
let cursor = state.queueCursor;
let batchCount = state.proofQueueBatchCount;

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
    await setStorageAt(base, request_batch_root({ leaves }));
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
console.log(
    `Nori bridge ${bridgeAddress}: cursor ${cursor}, ${batchCount} batches`
);
