# Backstop client

Sample client and keeper CLI, in Node. The browser apps are in [web/](../web/README.md).

- `createSnapshotEventMachine`: a snapshot transaction's `Snapshot` event, read from its receipt through the sdk's connections.
- `createProvenRequestMachine`: one proof request until Nori has proven its batch, with the request's witness in it; it gates on the sdk's proof request and witness machines, which its creator owns.
- `snapshotResultWitness`: the witness in the shape `Backstop.submitRead` and `NoriReadExample.readSnapshotResult` take; the contracts' ethers types (`@nori-zk/tempo-backstop`) encode the calls.

## Keeper

```sh
npm run keeper -- create-guards        # the keeper key is each guard's admin
npm run keeper -- run                  # or one step: snapshot | checkpoint | submit | status
npm run keeper -- unlatch              # admin: clear a trip, after a read shows the backing restored
```

The default config, `keeper.demo.json`, takes its `${VARS}` from the repo's `.env`
and the deploy outputs (see the root README, "Deploy"); an empty value counts as unset.
`ETH_PRIVATE_KEY` signs the snapshot transactions and `TEMPO_PRIVATE_KEY` the Tempo ones;
the Tempo account pays its fees in its fee token. Another config: pass its path last.

## Keeping ERC-20 mirrors paused as their ERC-20s are

nori-tempo-sdk's token bridge mirrors each locked ERC-20 on Tempo as a TIP-20, and the
mirror is paused and unpaused only by proof of the ERC-20's `paused()`. The keeper drives
both halves for each ERC-20 in its config's `mirrors`, with `ethereum.tokenBridge` set to
the Ethereum `NoriTokenBridge`:

```json
"ethereum": { "...": "...", "tokenBridge": "${NORI_ETH_TOKEN_BRIDGE_ADDRESS}" },
"mirrors": [{ "name": "usdc", "ethToken": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }]
```

```sh
npm run keeper -- sync-pauses    # syncPause each ERC-20 whose paused() changed, paying the queue fee in ETH
npm run keeper -- apply-pauses   # applyPause each synced pause whose batch Nori has proven
```

`sync-pauses` compares each ERC-20's `paused()` with the pause state the bridge last
synced and calls `NoriTokenBridge.syncPause` only when they differ, so a missed `Paused`
or `Unpaused` event is caught on the next round; it skips an ERC-20 whose mirror is not
registered on Tempo yet. `apply-pauses` waits for the batch that covers each sync, builds
its witness through the sdk and calls `NoriTempoTokenBridge.applyPause`, which pauses or
unpauses the mirror. `run` does both every round, and `status` adds a line per mirror.

## Overnight soak (a second, untouched guard)

`scripts/soak.sh [MINUTES=600] [OUT]` runs the keeper on `keeper.soak.json`: the demo guard
plus a shadow guard over a lockbox nobody touches, which should stay HEALTHY. The first
run deploys the shadow lockbox and token and creates the guards. It logs to
`OUT/keeper.log` and writes `OUT/report.md` at the end (also when stopped early):
snapshots, Ethereum block → reads applied, failures, checkpoint gaps, status changes.

## Local dry run (no prover, no testnet)

```sh
scripts/dry-run.sh                     # pauses before each step; --yes runs straight through
scripts/dry-run.sh --eth-rpc <mainnet or sepolia URL> --tempo-rpc https://rpc.moderato.tempo.xyz
```

It runs local chains (a Hardhat fork of `--eth-rpc`, `anvil --network tempo` forking `--tempo-rpc`) and the keeper. `fake-prover` stands in for Nori: it writes the proven batch into the Nori bridge's storage with `anvil_setStorageAt` and proves nothing. The script replays the Kelp drain on a demo lockbox: HEALTHY, then TRIPPED, then still TRIPPED after a refill. It exits non-zero if any status is wrong.

```
== 3. The batch is proven (fake-prover stands in for bridge-head + update); the keeper submits the reads
batch 0: requests [0, 1) at Ethereum block 11879818
Nori bridge 0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0: cursor 1, 1 batches
… snapshot 0x2b48…a915: reads submitted
… demo-lockbox: HEALTHY | backing 116723520000 | supply 116700000000 | Ethereum block 11879818 | paused false

== 4. Kelp drain: the lockbox drops to 223.52, then snapshot, prove, submit
… demo-lockbox: TRIPPED | backing 223520000 | supply 116700000000 | Ethereum block 11879820 | paused false | tripped at block 11879820, deficit 116475480000

== 5. The attacker refills to 40,300 and the lockbox pauses: it stays tripped, and its mirror on Tempo pauses
… lockbox-mirror: syncPause 0x287c…e688: paused true, block 11879823
… lockbox-mirror: mirror paused (proof queue batch 2)
… demo-lockbox: TRIPPED | backing 40300000000 | supply 116700000000 | Ethereum block 11879822 | paused true | tripped at block 11879820, deficit 116475480000
… lockbox-mirror: ERC-20 paused true | mirror 0x20c0…9950 paused true | 0 pause sync(s) waiting

== Done: HEALTHY -> TRIPPED on the drain -> still TRIPPED after the refill; the mirror follows the pause
```

`npm test` checks the witness against the Kelp vectors.
