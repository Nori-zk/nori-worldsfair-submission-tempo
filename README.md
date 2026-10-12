# Nori: World's Fair submission

Nori is infrastructure for reading Ethereum state from Solana and Tempo, proven instead of
relayed: no signers or oracles in between. This repo is the Tempo side of Nori's World's Fair
entry: `NoriSnapshot` batches any Ethereum view calls, and [`NoriRead`](tempo/README.md)
checks one answer inside any Tempo contract, in one call. Tempo gets a similar proof to
Solana's: its own proof request queue and its own Groth16 proof from the same Helios-in-SP1
program. Built on it: Backstop, a circuit breaker, and the migration of an ERC-20 to its
issuer's own TIP-20 on Tempo. The Solana side, live on real Nori proofs:
[nori-worldsfair-submission](https://github.com/Nori-zk/nori-worldsfair-submission). Both
sides together: [nori-worldsfair](https://github.com/Nori-zk/nori-worldsfair).

![How a read works](docs/how-it-works.drawio.png)

## Where it stands (12 Oct)

- **Ported and tested on local chains:** `NoriRead`, Backstop, the keeper and a fake
  prover. `scripts/dry-run.sh` runs the whole loop on a Sepolia fork and a local Tempo
  node: draining the lockbox trips the guard, and a refill doesn't reset it.
- **Token migration, local:** the migrate app runs end to end on local chains with a fake
  prover: lock the ERC-20 on Ethereum, proof, claim the issuer's TIP-20 on Tempo,
  reconciled. The issuer keeps admin of its TIP-20, only the committed recipient can
  claim, and a lock is permanent. `scripts/migrate-dry-run.sh` does the same from the CLI.
- **Not deployed:** nothing is on Tempo Moderato, and no Tempo infrastructure runs for the
  hackathon: the team had limited time and resources for a second one.
- **Next:** Sepolia → Tempo Moderato on real Nori proofs; mainnet after that.

Addresses and numbers: [docs/README.md](docs/README.md).

## Repo

| Path            | What                                                                                                                                                                                                                                                                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ethereum/`     | `NoriSnapshot` contract, query list, deploy and snapshot tasks                                                                                                                                                                                                                                                                                     |
| `tempo/`        | Solidity: `NoriRead` (verify a snapshot result in one call), `NoriReadExample`, Backstop (circuit breaker) ([README](tempo/README.md))                                                                                                                                                                                                             |
| `keeper/`       | Backstop keeper CLI, the migration CLI and their TS library: create-guards, snapshot, checkpoint, submit, status, unlatch, run; lock, claim ([README](keeper/README.md))                                                                                                                                                                           |
| `web/`          | Browser apps: prove an Ethereum balance on Tempo, migrate an ERC-20 to its issuer's TIP-20, and a live dashboard of the proof queue ([README](web/README.md))                                                                                                                                                                                      |
| `test-vectors/` | Test data shared by the contract and keeper tests                                                                                                                                                                                                                                                                                                  |
| `scripts/`      | `dry-run.sh` (the whole loop locally), `migrate-dry-run.sh` (the token migration locally, offline), `dev-local.sh` (the web apps on local chains), `outage.sh` (freeze or resume a local chain), `local-chains.sh` (the chains they start), `deploy-moderato.sh` (Backstop + demo token, not run yet), `soak.sh` (keeper for hours, then a report) |
| `docs/`         | [Index of all docs](docs/README.md), diagrams, the token migration                                                                                                                                                                                                                                                                                 |

## Run

Needs Node and npm, and Foundry 1.8.5 or later (`anvil --network tempo`). The token
migration also needs the Nori bridge with `adoptMirror`: until `@nori-zk/tempo-token-bridge`
0.0.3 is on npm, clone [nori-tempo-sdk](https://github.com/Nori-zk/nori-tempo-sdk) next to
this repo as `../nori-tempo-sdk`, on develop, or set `NORI_TEMPO_SDK` to its path. Without
it, `dev:local` runs prove-balance and the dashboard only.

```sh
git clone https://github.com/Nori-zk/nori-worldsfair-submission-tempo
npm install
# web/ needs a Nori bridge address and none is deployed: any address builds
NORI_TEMPO_TOKEN_BRIDGE_ADDRESS=0x0000000000000000000000000000000000000001 npm run build
anvil --network tempo &         # the tempo/ tests' local node
npm test                        # ethereum contracts (36), tempo contracts (26), then the keeper (2)
npm test -w web/libs/ui         # the web apps' shared library (2)
npm run lint                    # every workspace
scripts/dry-run.sh              # the whole loop on local chains, with a fake prover
scripts/migrate-dry-run.sh      # the token migration on local chains, offline, with a fake prover
npm run dev:local -- --offline  # the web apps on local chains (without --offline it forks Sepolia)
npm run outage -- eth|tempo down|up  # freeze or resume one of those chains
```

The build needs no migration addresses: without them the migrate app builds a page that
says "Not configured yet", and `dev:local` fills them in for its local chains.
Toolchain notes: [AGENTS.md](AGENTS.md).
The Nori SDK comes from npm: each `package.json` pins its packages to exact versions
from one release of [nori-tempo-sdk](https://github.com/Nori-zk/nori-tempo-sdk).

## Apps

Browser apps, run on local chains with `npm run dev:local` ([web/README.md](web/README.md)).
Against a deployment they need its addresses in `web/.env`:

```sh
npm run dev -w web/apps/prove-balance   # prove an address's ETH or token balance on Tempo: http://localhost:5180
npm run dev -w web/apps/migrate         # migrate an ERC-20 to its issuer's TIP-20 on Tempo: http://localhost:5181
npm run dev -w web/dashboards/bridge    # every proof request from Ethereum to Tempo, live: http://localhost:7400
```

## Deploy (Sepolia + Tempo Moderato)

Not run for the hackathon: nothing is deployed on Moderato. Keys and addresses live in one
`.env`: `cp .env.example .env`, then fill it in. The Tempo account pays its fees in pathUSD
(Moderato's faucet).

```sh
# Ethereum: NoriSnapshot on the existing queue, and a demo lockbox
npm run deploy -w ethereum                     # -> ethereum/.env.nori-eth-snapshot
npm run deploy-demo -w ethereum -- 116723.52   # -> ethereum/.env.nori-eth-demo

# Tempo: Backstop, and a demo TIP-20 with supply 116,700 (-> tempo/.env.nori-tempo-*); safe to rerun
scripts/deploy-moderato.sh

# Keeper: keeper/keeper.demo.json reads .env and the deploy outputs
npm run keeper -w keeper -- create-guards
npm run keeper -w keeper -- status   # Nori's progress through the queue, then each guard
npm run keeper -w keeper -- run
```

bridge-head proves `NORI_ETH_PROOF_QUEUE_ADDRESS` and updates `NORI_TEMPO_TOKEN_BRIDGE_ADDRESS`.
Create guards only after that bridge is deployed: a guard pins it.

## Built vs roadmap

|                                                                                         | Status                            |
| --------------------------------------------------------------------------------------- | --------------------------------- |
| NoriSnapshot (batched reads) and `NoriRead`                                             | Built                             |
| Backstop guards: trip rule, latch, paused-at-source, stale, `assertHealthy` for lenders | Built                             |
| Keeper (`keeper/`), local dry run                                                       | Built                             |
| Token migration: the migrate app, the migration CLI, `migrate-dry-run.sh`               | Built (local chains, fake prover) |
| Browser apps: prove a balance, migrate, bridge dashboard                                | Built (local chains)              |
| Live loop on Sepolia + Tempo Moderato                                                   | Next (nothing deployed)           |
| Separate warn tolerance (in-flight transfers) from the trip tolerance                   | Roadmap (one `tolerance` today)   |
| Auto-unlatch for Tempo-only custody; timelocked admin `unlatch`                         | Roadmap (admin `unlatch` today)   |
| Check the TIP-20's issuer is the expected bridge                                        | Roadmap                           |
| Direct storage proofs: any slot, no Ethereum transaction                                | Roadmap                           |

Direct proofs work because each Nori update already puts Ethereum's state
root on Tempo. The hackathon build uses snapshots through the existing proof queue.

## What was built during the hackathon

Before the World's Fair started on 14 Sep 2026, Nori had its prover,
[nori-bridge-head](https://github.com/Nori-zk/nori-bridge-head) (Helios inside SP1, a fork of
Succinct's sp1-helios), and its SP1 v6 fork of Succinct's
[sp1-solana](https://github.com/Nori-zk/sp1-solana) verifier; nori-solana-sdk held a 332-line
stub program. This repo was forked from the
[Solana submission](https://github.com/Nori-zk/nori-worldsfair-submission) on 9 Oct, and
[nori-tempo-sdk](https://github.com/Nori-zk/nori-tempo-sdk) from nori-solana-sdk the same day.
Everything else in both was built during the hackathon, from 14 Sep on, and everything
Tempo-specific since 9 Oct: the prover's Tempo port, the Solidity `NoriRead` and Backstop,
the Nori bridge on Tempo, the token migration and the Tempo web apps.
