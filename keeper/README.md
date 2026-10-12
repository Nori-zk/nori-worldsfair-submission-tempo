# Backstop keeper and migration CLI

Keeper CLI, the migration CLI and their library, in Node. The browser apps are in
[web/](../web/README.md).

- `createSnapshotEventMachine`: a snapshot transaction's `Snapshot` event, read from its receipt through the sdk's connections.
- `createProvenRequestMachine`: one proof request until Nori has proven its batch, with the request's witness in it; it gates on the sdk's proof request and witness machines, which its creator owns.
- `snapshotResultWitness`: the witness in the shape `Backstop.submitRead` and `NoriReadExample.readSnapshotResult` take; the contracts' ethers types (`@nori-zk/tempo-backstop`) encode the calls.
- `createProvenCallMachine`: one proof request until Nori has proven it, then the call on the Tempo bridge that takes its proven leaf, sent until mined or refused: the keeper's `applyPause`, and a holder's `mintERC20` claim.

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

## Migration CLI

Moves an Ethereum ERC-20 to its TIP-20 on Tempo through nori-tempo-sdk's token bridge
([docs/README.md, "Token migration"](../docs/README.md#token-migration)): the holder locks it on Ethereum
for a Tempo recipient, Nori proves the lock, and the recipient claims it on Tempo.

```sh
npm run migrate -- lock dusd 1000.5 [tempoRecipient]   # approve if needed, then lockERC20 (the queue fee in ETH)
npm run migrate -- claim                               # mintERC20 for each lock Nori has proven
npm run migrate -- status                              # locked on Ethereum against minted on Tempo
```

The default config, `migration.demo.json`, takes its `${VARS}` from the repo's `.env`
and the deploy outputs; `--config <path>` picks another. `ETH_PRIVATE_KEY` is the holder,
`TEMPO_PRIVATE_KEY` the recipient (the default recipient of a lock, and the only one that
can claim it). Pending locks are kept in `stateFile`.

- `lock` amounts are in the token's units with at most 6 decimals: a TIP-20 has 6, and
  the bridge refuses dust below one TIP-20 unit. A paused ERC-20 sends nothing.
- `claim` mints what is locked for the recipient and not minted yet, so a lock a later
  claim covered is done (`ZeroMintAmount`). A claim refused for now (the mirror paused,
  its supply cap reached) stays pending.
- `status` reads `totalLockedERC20BU` on Ethereum against `erc20TotalMinted` on Tempo:
  minted never exceeds locked, and the difference is locked but not claimed yet.

The ERC-20's pause reaches its TIP-20 through the keeper, below, with
`keeper.migration.json`: no guards, DUSD as its one mirror.

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

A keeper with no guards only relays pauses: `run` then skips snapshots and checkpoints
(`npm run keeper -- run keeper.migration.json`).

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

## Local dry runs (no prover, no testnet)

`scripts/migrate-dry-run.sh [--yes]` migrates DUSD on local chains, offline: Nori (dev
account 0) deploys the bridges, the issuer (1) deploys DUSD on Ethereum and its own
TIP-20 on Tempo, which Nori adopts, and the holder (2) locks 1,000.5 DUSD and claims it
on Tempo; then the issuer's pause and unpause reach the TIP-20 through the keeper.

```
== 3. Nori proves the batch (fake-prover stands in for bridge-head + update); the holder claims on Tempo
batch 0: requests [0, 1) at Ethereum block 8
dusd: claimed on Tempo by 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC: 1000.5 locked for it in all, minted (proof queue batch 0)
dusd: DUSD on Ethereum paused false | Tempo mirror 0x20c0…978F paused false | minted 1000.5 of 1000.5 locked, reconciled | 0x3C44…93BC: 1000.5 locked for it, holds 1000.5 | 0 lock(s) waiting

== 4. The issuer pauses DUSD on Ethereum; the keeper syncs it, Nori proves it, the keeper applies it: the TIP-20 pauses on Tempo
DemoIssuerToken: paused true (block 9)
dusd: syncPause mined, paused true
dusd: mirror paused (proof queue batch 1)
A transfer on Tempo while paused: reverted with ContractPaused()
dusd: DUSD is paused by its issuer on Ethereum; locks wait for the unpause

== 5. The issuer unpauses on Ethereum; the same path unpauses the TIP-20, and transfers work again
dusd: mirror unpaused (proof queue batch 2)
A transfer on Tempo after the unpause: true

== Done: 1,000.5 DUSD locked on Ethereum = 1,000.5 minted on Tempo, into the issuer's own TIP-20; its pause followed Ethereum both ways, by proof
```

Backstop's:

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
