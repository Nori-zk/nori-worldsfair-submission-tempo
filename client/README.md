# Client

Sample clients in Node: the migration CLI and Backstop's keeper. The browser apps are in
[web/](../web/README.md). Both sign through their own ethers clients and read proof requests
and Nori's state through nori-tempo-sdk's `createConnections`.

## Migration CLI

Moves an Ethereum ERC-20 to its TIP-20 mirror on Tempo through nori-tempo-sdk's token
bridge ([docs/tempo-migration.md](../docs/tempo-migration.md)), and keeps the mirror
paused as the ERC-20 is.

```sh
npm run migrate -- lock dusd 1000.5 [tempoRecipient]   # approve if needed, then lockERC20 (the queue fee in ETH)
npm run migrate -- claim          # mintERC20 for each lock Nori has proven (the Tempo key is the recipient)
npm run migrate -- sync-pauses    # syncPause each ERC-20 whose paused() changed
npm run migrate -- apply-pauses   # applyPause each synced pause whose batch Nori has proven
npm run migrate -- status         # both chains: pause, locked against minted, reconciled
npm run migrate -- run            # claim, sync-pauses and apply-pauses every round
```

The default config, `migration.demo.json`, takes its `${VARS}` from the repo's `.env` and
the deploy outputs (`scripts/deploy-migration.sh`); `--config <path>` picks another.
`ETH_PRIVATE_KEY` signs on Ethereum (the holder's key for `lock`), `TEMPO_PRIVATE_KEY` on
Tempo (the recipient's for `claim`; any key holding a fee token for `apply-pauses`). The
pending locks and pause syncs are kept in `stateFile`.

- `lock` amounts are in the token's units with at most 6 decimals: a TIP-20 has 6, and the
  bridge refuses dust below one TIP-20 unit.
- `claim` is delta-based: it mints what is locked for the recipient and not minted yet, so a
  lock a later claim covered is done (`ZeroMintAmount`).
- `sync-pauses` compares the ERC-20's `paused()` with the pause state the bridge last synced
  and syncs only when they differ, so a missed event is caught on the next round; it skips
  an ERC-20 with no mirror on Tempo. `apply-pauses` waits for the batch, builds its witness
  through the sdk and calls `applyPause`; an older batch than one already applied is dropped.
- `status` reads `totalLockedERC20BU` on Ethereum against `erc20TotalMinted` on Tempo:
  minted never exceeds locked, and the difference is locked but not claimed yet.

## Keeper (Backstop)

```sh
npm run keeper -- create-guards <config.json>   # the keeper key is each guard's admin
npm run keeper -- run <config.json>             # or one step: snapshot | checkpoint | submit | status
npm run keeper -- unlatch <config.json>         # admin: clear a trip, after a read shows the backing restored
```

`scripts/dry-run.sh` writes a config for its local chains. `ETH_PRIVATE_KEY` signs the
snapshot transactions and `TEMPO_PRIVATE_KEY` the Tempo ones. Backstop's live deployment,
with its keeper on real proofs and a 10-hour soak, is the Solana one
([nori-worldsfair-submission](https://github.com/Nori-zk/nori-worldsfair-submission)).

- `fetchProvenSnapshot`: snapshot transaction -> the batch index and the witness for any of its results, once Nori has proven its batch.
- `snapshotResultWitness`: the witness in the shape `Backstop.submitRead` and `NoriReadExample.readSnapshotResult` take.

## Local dry runs (no prover, no testnet)

Both run local chains (Hardhat for Ethereum, `anvil --network tempo` for Tempo) and stand
`fake-prover` in for Nori: it writes each proof queue batch into the Nori bridge's storage
with `anvil_setStorageAt`, as `update` would, and proves nothing. Both need no network
access, and exit non-zero if a check fails.

```sh
scripts/migrate-dry-run.sh            # pauses before each step; --yes runs straight through
scripts/dry-run.sh --offline          # Backstop; --eth-rpc <URL> forks a chain instead
```

`migrate-dry-run.sh`: Nori (dev account 0) deploys the bridges, the issuer (1) deploys DUSD
on Ethereum and its own TIP-20 on Tempo, which Nori adopts, and the holder (2) migrates.

```
== 3. Nori proves the batch (fake-prover stands in for bridge-head + update); the holder claims on Tempo
batch 0: requests [0, 1) at Ethereum block 7
dusd: minted 1000.5 on Tempo to 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC (proof queue batch 0)
dusd: Tempo mirror 0x20c0…8307 (the issuer's own TIP-20) | paused false | minted 1000.5 of 1000.5 locked, 0.0 unclaimed | supply 1000.5 | 0x3C44…93BC holds 1000.5

== 4. The issuer pauses DUSD on Ethereum; anyone syncs it, Nori proves it, anyone applies it: the TIP-20 pauses on Tempo
DemoIssuerToken: paused true (block 8)
dusd: syncPause 0xdddc…1f0c: paused true, block 9
dusd: mirror paused on Tempo (proof queue batch 1)
A transfer on Tempo while paused: reverted with ContractPaused()

== 5. The issuer unpauses on Ethereum; the same path unpauses the TIP-20, and transfers work again
dusd: mirror unpaused on Tempo (proof queue batch 2)
A transfer on Tempo after the unpause: true

== Done: 1,000.5 DUSD locked on Ethereum = 1,000.5 minted on Tempo, into the issuer's own TIP-20; its pause followed Ethereum both ways, by proof
```

`dry-run.sh` replays the Kelp drain on a demo lockbox: HEALTHY, then TRIPPED, then still
TRIPPED after a refill and a pause.

`npm test` checks the snapshot witness against the Kelp vectors.
