# Docs

## Start here

- [README](../README.md): what this is, how to run it, how to deploy.
- [Tempo's migration guide, mapped](tempo-migration.md): the bridge adapter path, the guide's checklist, the sync signer replaced by a proof, lock or burn.
- [How a read works](how-it-works.drawio.png): the whole loop, Ethereum to any Tempo contract.
- [AGENTS.md](../AGENTS.md): commands, quirks and the rules that bite (for developers and coding agents).

## By part

| Doc                                                                             | What                                                                                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [ethereum/README.md](../ethereum/README.md)                                     | `NoriSnapshot`: the proven leaf, what a consumer must check, commands, gas; the issuer's ERC-20         |
| [tempo/README.md](../tempo/README.md)                                           | `NoriRead` in your contract, and Backstop: circuit breakers; [guard diagram](backstop-guard.drawio.png) |
| [client/README.md](../client/README.md)                                         | The migration CLI, Backstop's keeper and the local dry runs                                             |
| [web/README.md](../web/README.md)                                               | Browser apps: migrate an ERC-20 to Tempo, bridge dashboard                                              |
| [test-vectors/nori-snapshot/README.md](../test-vectors/nori-snapshot/README.md) | Test data shared by the contract and client tests                                                       |

Upstream: the Nori SDK, the sibling checkout `../nori-tempo-sdk` (its `README.md`,
`sdk/README.md` and `DEPLOYMENT.md`), and the prover, nori-bridge-head on branch
`FEAT/tempo-bridge-sepolia-glamsterdam`.

## Diagrams

Edit the `.drawio` files in [draw.io](https://app.diagrams.net); the `.drawio.png` exports embed them, so either one opens for editing. To export after an edit:

```sh
drawio --export --format png --embed-diagram --border 10 -o docs/<name>.drawio.png docs/<name>.drawio
```

## Deployments

The Ethereum side, on Sepolia:

| What                   | Address                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Proof queue (Sepolia)  | [`0x9AeAc0174f7bDf397C6dB1f62c120E8170e5B87e`](https://sepolia.etherscan.io/address/0x9AeAc0174f7bDf397C6dB1f62c120E8170e5B87e) |
| NoriSnapshot (Sepolia) | [`0xC377EbBF516a9DB2Fe5AEB65fA19D4dca1717340`](https://sepolia.etherscan.io/address/0xC377EbBF516a9DB2Fe5AEB65fA19D4dca1717340) |
| Demo lockbox (Sepolia) | [`0xC8e4AAF5Db40bCE6aC2Ed89e1676D882044FD543`](https://sepolia.etherscan.io/address/0xC8e4AAF5Db40bCE6aC2Ed89e1676D882044FD543) |

Not deployed yet: the Nori bridge for Tempo (nori-tempo-sdk's `NoriTokenBridge` on Sepolia
and `NoriTempoTokenBridge` on Moderato, its `DEPLOYMENT.md`), then the migration demo with
`scripts/deploy-migration.sh` (the issuer's DUSD on Sepolia, its TIP-20 on Moderato). Their
addresses go in the repo's `.env`, `web/.env`, and the `ethereum/.env.nori-eth-*` and
`tempo/.env.nori-tempo-*` outputs.

Measured on local chains (`scripts/migrate-dry-run.sh`, `scripts/dry-run.sh` and the
`tempo/` tests):

- **Migration:** 1,000.5 DUSD (18 decimals) locked on Ethereum, 1,000.5 minted on Tempo (6
  decimals) into the issuer's own TIP-20; the issuer's pause on Ethereum paused it on Tempo
  (a transfer reverted with `ContractPaused()`), and the unpause lifted it.
- **Drain demo:** the lockbox drained to 223.52 tripped the guard (deficit 116,475.48); a
  refill to 40,300 plus a pause kept it tripped.
- **Costs:** `submitRead` 337,042 gas for a guard's first backing read (a new slot costs
  250,000 on Tempo), 87,651 for a later one, 61,063 for a pause read; `assertHealthy`
  38,322; a whole `NoriReadExample` read at most 49,332. A 4-query snapshot costs 753,817
  gas on Sepolia (see `ethereum/README.md`).

`npm run migrate -w client -- status` shows the migration on both chains;
`npm run keeper -w client -- status <config>` shows how far Nori has proven the queue, and each guard.
