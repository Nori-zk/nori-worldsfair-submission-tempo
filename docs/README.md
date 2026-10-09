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
| [client/README.md](../client/README.md)                                         | Sample client, keeper CLI and the local dry run                                                         |
| [web/README.md](../web/README.md)                                               | Browser apps: prove a balance, bridge dashboard                                                         |
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

| What                     | Address                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Proof queue (Sepolia)    | [`0x9AeAc0174f7bDf397C6dB1f62c120E8170e5B87e`](https://sepolia.etherscan.io/address/0x9AeAc0174f7bDf397C6dB1f62c120E8170e5B87e) |
| NoriSnapshot (Sepolia)   | [`0xC377EbBF516a9DB2Fe5AEB65fA19D4dca1717340`](https://sepolia.etherscan.io/address/0xC377EbBF516a9DB2Fe5AEB65fA19D4dca1717340) |
| Demo lockbox (Sepolia)   | [`0xC8e4AAF5Db40bCE6aC2Ed89e1676D882044FD543`](https://sepolia.etherscan.io/address/0xC8e4AAF5Db40bCE6aC2Ed89e1676D882044FD543) |
| Shadow lockbox (Sepolia) | [`0xC1E34c6f16d4284520EFE86AE304a895F1Be84C9`](https://sepolia.etherscan.io/address/0xC1E34c6f16d4284520EFE86AE304a895F1Be84C9) |

The Tempo side goes on Moderato: the Nori bridge with nori-tempo-sdk's deploy
(`DEPLOYMENT.md`), then Backstop and the demo token with `scripts/deploy-moderato.sh`
(README, "Deploy"). Their addresses go in the repo's `.env` and the `tempo/.env.nori-tempo-*`
outputs.

Measured on local chains (`scripts/dry-run.sh` and the `tempo/` tests):

- **Drain demo:** the lockbox drained to 223.52 tripped the guard (deficit 116,475.48); a
  refill to 40,300 plus a pause kept it tripped.
- **Costs:** `submitRead` 337,042 gas for a guard's first backing read (a new slot costs
  250,000 on Tempo), 87,651 for a later one, 61,063 for a pause read; `assertHealthy`
  38,322; a whole `NoriReadExample` read at most 49,332. A 4-query snapshot costs 753,817
  gas on Sepolia (see `ethereum/README.md`).

`npm run keeper -w client -- status` shows how far Nori has proven the queue, and each guard.
