# Nori on Tempo: World's Fair submission

Move an Ethereum ERC-20 to Tempo, proven instead of signed.

Tempo's [ERC-20 migration guide](https://tempo.xyz/developers/docs/guide/issuance/migrate-erc20-to-tip20)
offers a **bridge adapter** path: the ERC-20 stays canonical on Ethereum, holders lock it
there, and an adapter holding `ISSUER_ROLE` mints the TIP-20 on Tempo. It leaves the
issuer to run a "sync signer" that carries state, such as compliance lists or a pause,
across. Nori is that adapter with no signer: each mint and each pause rests on an SP1
proof of Ethereum's finalized state, checked on Tempo.

## Two use cases, one proof stack

|                 | **Token migration** (Tempo's flagship)                                                                                                     | **Backstop** (on both chains)                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What            | Lock an ERC-20 on Ethereum, claim its TIP-20 on Tempo. The issuer keeps the TIP-20's admin; the ERC-20's `paused()` reaches Tempo by proof | A circuit breaker for a bridged asset: its Ethereum backing, proven, against its supply on the destination chain                                                                   |
| Where           | This repo: [`web/apps/migrate`](web/README.md), the [migration CLI](client/README.md), `scripts/migrate-dry-run.sh`                        | **Solana is the live showcase:** [nori-worldsfair-submission](https://github.com/Nori-zk/nori-worldsfair-submission). Here: the same guard in Solidity ([tempo/](tempo/README.md)) |
| Built on        | nori-tempo-sdk's `NoriTokenBridge` (Ethereum) and `NoriTempoTokenBridge` (Tempo)                                                           | `NoriSnapshot` (Ethereum) and `NoriRead` (Tempo)                                                                                                                                   |
| Status (10 Oct) | Built and tested on local chains; the app driven end to end in a browser on them                                                           | Solana: on real proofs, Sepolia → devnet, since 7 Oct. Tempo: built and tested on local chains                                                                                     |

Both read the same thing: Nori's proof queue batches, committed on Tempo by
`NoriTempoTokenBridge.update` after it verifies the SP1 Groth16 proof.

## Migration: how it works

```mermaid
sequenceDiagram
    participant Issuer
    participant Holder
    participant ETH as NoriTokenBridge (Ethereum)
    participant Nori as Nori prover (Helios in SP1)
    participant Tempo as NoriTempoTokenBridge (Tempo)
    participant TIP20 as Issuer's TIP-20

    Note over Issuer,TIP20: Once: the issuer creates its TIP-20 (admin: the issuer) and grants the bridge ISSUER_ROLE, PAUSE_ROLE and UNPAUSE_ROLE; Nori adopts it (adoptMirror)
    Holder->>ETH: lockERC20(token, amount, sha256(tempoRecipient))
    Note over ETH: Locked for good: no unlock path. 18 decimals become 6, dust refused
    ETH-->>Nori: proof request: lockedERC20[token][recipient]
    Nori->>Tempo: update(proof) after Ethereum finality: batch root committed
    Holder->>Tempo: mintERC20(witness): only the committed recipient
    Tempo->>TIP20: mint(locked so far − minted so far)
    Issuer->>ETH: pause() on the ERC-20, then anyone: syncPause(token)
    Nori->>Tempo: update(proof)
    Note over Tempo,TIP20: anyone: applyPause(witness), newer batches only
    Tempo->>TIP20: pause(): transfers, mints and burns stop on Tempo too
```

Tempo's guide, item by item, and how lock becomes burn: [docs/tempo-migration.md](docs/tempo-migration.md).

| Tempo's guide asks                                               | Nori                                                                                                                                                     |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bridge adapter with `ISSUER_ROLE`; enforce limits in the adapter | `NoriTempoTokenBridge` mints only what a proof shows locked, per recipient; `erc20TotalMinted` never exceeds `totalLockedERC20BU` on Ethereum            |
| Admin controlled by the issuer                                   | `adoptMirror`: the issuer creates the TIP-20 and keeps `DEFAULT_ADMIN_ROLE` (TIP-403 policy, supply cap, logo, roles); the bridge checks its three roles |
| Lock or burn the legacy supply                                   | Locked in `NoriTokenBridge`, which has no unlock path: retired on Ethereum. Burning instead changes how `lockERC20` takes the tokens, nothing on Tempo   |
| 18 → 6 decimals, decide on dust                                  | One TIP-20 unit is 10¹² of an 18-decimal token's units; an amount with dust below that is refused at lock                                                |
| A sync signer keeps state in step                                | The ERC-20's `paused()` is proven and applied (`syncPause`, `applyPause`); anyone can relay it, nobody can forge it                                      |

## Where it stands (10 Oct)

- **Migration, built and tested on local chains:** the contracts (nori-tempo-sdk's Tempo
  suite, 55 tests, 11 new for issuer-owned TIP-20s and minted totals), the CLI, and
  `scripts/migrate-dry-run.sh`: lock 1,000.5 DUSD, claim it into the issuer's own TIP-20, then
  the issuer's pause and unpause on Ethereum followed on Tempo by proof. The web app ran
  the lock → proof → claim flow end to end in headless Chromium on the same local chains.
- **Backstop on Tempo, built and tested on local chains:** `scripts/dry-run.sh` replays the
  Kelp drain (HEALTHY → TRIPPED, still TRIPPED after a refill). On Solana the same guard
  runs on real proofs.
- **Not live on Tempo yet:** the Nori bridge on Moderato, then `scripts/deploy-migration.sh`,
  come next. Every run here uses `fake-prover`, which writes the batches a real proof would
  commit and proves nothing.

Addresses and numbers: [docs/README.md](docs/README.md).

## Run

```sh
git clone https://github.com/Nori-zk/nori-worldsfair-submission-tempo
npm install && npm run build
anvil --network tempo &          # the tempo/ tests' local node
npm test                         # ethereum contracts, the tempo contracts, then the client
npm run lint                     # every workspace
scripts/migrate-dry-run.sh       # migration on local chains, fake prover, no network needed
scripts/dry-run.sh --offline     # Backstop on local chains
```

The Nori SDK is the sibling checkout `../nori-tempo-sdk`, referenced by path (`file:`) from
each `package.json` until its 0.0.2 is on npm; build it first (its README).
Toolchain notes: [AGENTS.md](AGENTS.md).

## Apps

Browser apps on Sepolia + Tempo Moderato ([web/README.md](web/README.md)); they need the
addresses in `web/.env`:

```sh
npm run dev -w web/apps/migrate         # lock on Sepolia, claim on Tempo: http://localhost:5180
npm run dev -w web/dashboards/bridge    # every proof request from Ethereum to Tempo, live: http://localhost:7400
```

## Deploy the migration demo (Sepolia + Tempo Moderato)

On a Nori bridge already deployed (nori-tempo-sdk's `DEPLOYMENT.md`: `NoriTokenBridge` on
Sepolia, `NoriTempoTokenBridge` on Moderato). Keys and addresses live in one `.env`:
`cp .env.example .env`, then fill it in. Tempo accounts pay fees in pathUSD (Moderato's faucet).

```sh
scripts/deploy-migration.sh --holder 0x...      # the issuer's DUSD on Sepolia, its TIP-20 on Moderato, adopted
npm run migrate -w client -- lock dusd 100       # as the holder
npm run migrate -w client -- status              # locked on Ethereum against minted on Tempo
npm run migrate -w client -- claim               # once Nori has proven the lock
npm run issuer-pause -w ethereum                 # as the issuer; then:
npm run migrate -w client -- run                 # syncs and applies the pause, claims what is proven
```

## Repo

| Path            | What                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ethereum/`     | `NoriSnapshot`, `DemoIssuerToken` (the issuer's ERC-20), deploy and snapshot tasks ([README](ethereum/README.md))          |
| `tempo/`        | Solidity: `NoriRead` (verify a snapshot result in one call), `NoriReadExample`, Backstop ([README](tempo/README.md))       |
| `client/`       | The migration CLI (lock, claim, sync-pauses, apply-pauses, status, run) and Backstop's keeper ([README](client/README.md)) |
| `web/`          | Browser apps: migrate an ERC-20 to Tempo, and a live dashboard of the proof queue ([README](web/README.md))                |
| `scripts/`      | `migrate-dry-run.sh` and `dry-run.sh` (local chains), `deploy-migration.sh` (Sepolia + Moderato)                           |
| `test-vectors/` | Test data shared by the contract and client tests                                                                          |
| `docs/`         | [Index of all docs](docs/README.md), [Tempo's migration guide, mapped](docs/tempo-migration.md), diagrams, deployments     |

## Built vs roadmap

|                                                                                      | Status                                                                     |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Migration: lock on Ethereum, mint the TIP-20 on Tempo against a proof                | Built (local chains)                                                       |
| Issuer-owned TIP-20 (`adoptMirror`), the issuer keeping admin, policy and supply cap | Built (nori-tempo-sdk 0.0.2)                                               |
| Pause mirroring: the ERC-20's `paused()` → the TIP-20's `pause()`, by proof          | Built (local chains)                                                       |
| Migrate app and bridge dashboard                                                     | Built (local chains); Sepolia + Moderato once deployed                     |
| Backstop guards on Tempo: trip rule, latch, paused-at-source, stale, `assertHealthy` | Built (local chains); live on Solana                                       |
| Live loop on Sepolia + Tempo Moderato                                                | Next                                                                       |
| Burn instead of lock on Ethereum                                                     | A change to `lockERC20` only ([how](docs/tempo-migration.md#lock-or-burn)) |
| TIP-403 policy mirroring: an issuer's Ethereum allow or block list proven onto Tempo | Roadmap: the same proof path as the pause                                  |
| A rotatable, timelocked mirror admin on Tempo                                        | Roadmap (the bridge's deployer today)                                      |
| Direct storage proofs: any slot, no Ethereum transaction                             | Roadmap                                                                    |
