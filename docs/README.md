# Docs

## Start here

- [README](../README.md): what this is, how to run it, how to deploy.
- [How a read works](how-it-works.drawio.png): the whole loop, Ethereum to any Tempo contract.
- [AGENTS.md](../AGENTS.md): commands, quirks and the rules that bite (for developers and coding agents).

## By part

| Doc                                                                             | What                                                                                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [ethereum/README.md](../ethereum/README.md)                                     | `NoriSnapshot`: the proven leaf, what a consumer must check, commands, gas                              |
| [tempo/README.md](../tempo/README.md)                                           | `NoriRead` in your contract, and Backstop: circuit breakers; [guard diagram](backstop-guard.drawio.png) |
| [keeper/README.md](../keeper/README.md)                                         | Keeper CLI, the migration CLI, their library and the local dry runs                                     |
| [web/README.md](../web/README.md)                                               | Browser apps: prove a balance, migrate, bridge dashboard                                                |
| [test-vectors/nori-snapshot/README.md](../test-vectors/nori-snapshot/README.md) | Test data shared by the contract and keeper tests                                                       |

Upstream: the Nori SDK, [nori-tempo-sdk](https://github.com/Nori-zk/nori-tempo-sdk) (its `README.md`,
`sdk/README.md` and `DEPLOYMENT.md`), and the prover, nori-bridge-head on branch
`FEAT/tempo-bridge-sepolia-glamsterdam`.

## Token migration

An issuer's ERC-20 on Ethereum moves to the issuer's own TIP-20 on Tempo: the bridge adapter
path of Tempo's migration guide, with a Nori proof where the guide has a sync signer. The
holder locks the ERC-20 in nori-tempo-sdk's `NoriTokenBridge`, Nori proves the lock, and the
committed recipient claims the TIP-20 on Tempo, 1:1; only it can. The issuer creates the
TIP-20 and stays its admin; Nori's bridge adopts it (`adoptMirror`) with the mint and pause
roles, and the ERC-20's pause reaches Tempo by proof too. Runs on local chains only, with a
fake prover:

```sh
scripts/migrate-dry-run.sh --yes   # offline: lock 1,000.5 DUSD and claim it; the issuer's pause and unpause follow
```

It needs nori-tempo-sdk on develop as `../nori-tempo-sdk`, or at `NORI_TEMPO_SDK`, until
`@nori-zk/tempo-token-bridge` 0.0.3 is on npm. In the browser: `npm run dev:local -- --offline`
and the [migrate app](../web/README.md#migrate); from Node: the
[migration CLI](../keeper/README.md#migration-cli).

Limits:

- A lock is permanent: the bridge has no unlock path.
- The issuer keeps admin of its TIP-20, so it can mint its own supply (only what the bridge
  mints is backed by locks) and unpause on Tempo after the bridge paused. A pause set only
  on Tempo is undone by anyone through `syncPause` and `applyPause` while the ERC-20 is
  unpaused: Ethereum's pause is the source of truth.
- An issuer that revokes the bridge's mint role (`ISSUER_ROLE`) or blacklists a holder
  leaves that holder's ERC-20 locked on Ethereum for good.

## Diagrams

Edit the `.drawio` files in [draw.io](https://app.diagrams.net); the `.drawio.png` exports embed them, so either one opens for editing. To export after an edit:

```sh
drawio --export --format png --embed-diagram --border 10 -o docs/<name>.drawio.png docs/<name>.drawio
```

## Deployments

Nothing is deployed on Tempo Moderato: no Nori bridge, Backstop, demo token or migrated
TIP-20, and no Tempo infrastructure runs for the hackathon. The Ethereum contracts this
repo's config points at are the Solana submission's, on Sepolia:

| What                     | Address                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Proof queue (Sepolia)    | [`0x9AeAc0174f7bDf397C6dB1f62c120E8170e5B87e`](https://sepolia.etherscan.io/address/0x9AeAc0174f7bDf397C6dB1f62c120E8170e5B87e) |
| NoriSnapshot (Sepolia)   | [`0xC377EbBF516a9DB2Fe5AEB65fA19D4dca1717340`](https://sepolia.etherscan.io/address/0xC377EbBF516a9DB2Fe5AEB65fA19D4dca1717340) |
| Demo lockbox (Sepolia)   | [`0xC8e4AAF5Db40bCE6aC2Ed89e1676D882044FD543`](https://sepolia.etherscan.io/address/0xC8e4AAF5Db40bCE6aC2Ed89e1676D882044FD543) |
| Shadow lockbox (Sepolia) | [`0xC1E34c6f16d4284520EFE86AE304a895F1Be84C9`](https://sepolia.etherscan.io/address/0xC1E34c6f16d4284520EFE86AE304a895F1Be84C9) |

A Moderato deployment follows nori-tempo-sdk's `DEPLOYMENT.md` (its own queue and bridge on
Ethereum, the Nori bridge on Tempo), then Backstop and the demo token with
`scripts/deploy-moderato.sh` (README, "Deploy"). Their addresses go in the repo's `.env` and
the `tempo/.env.nori-tempo-*` outputs.

Measured on local chains (`scripts/dry-run.sh` and the `tempo/` tests):

- **Drain demo:** the lockbox drained to 223.52 tripped the guard (deficit 116,475.48); a
  refill to 40,300 plus a pause kept it tripped.
- **Costs:** `submitRead` 337,042 gas for a guard's first backing read (a new slot costs
  250,000 on Tempo), 87,651 for a later one, 61,063 for a pause read; `assertHealthy`
  38,322; a whole `NoriReadExample` read at most 49,332. A 4-query snapshot costs 753,817
  gas on Sepolia (see `ethereum/README.md`).

`npm run keeper -w keeper -- status` shows how far Nori has proven the queue, and each guard.
