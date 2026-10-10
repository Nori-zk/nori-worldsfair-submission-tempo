# web: browser apps

Two apps on Sepolia + Tempo Moderato, built with [yaw](https://yaw-rx.github.io/) and
[ystate](https://ystate.github.io/) on the Nori SDK. Each app's flow is a ystate graph,
drawn next to it (`MigrateGraph.svg`, `BridgeBatchesGraph.svg`).

| Package             | What                                                                                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/migrate`      | Migrate an Ethereum ERC-20 to its TIP-20 on Tempo: lock on Ethereum from your wallet, follow Nori's proof, claim on Tempo; both chains' pause and supply side by side                              |
| `dashboards/bridge` | The whole proof queue: every batch Nori has settled on Tempo, the requests still waiting, and the stage Nori's prover is in                                                                        |
| `libs/ui`           | Shared: wallet and connection buttons, the connection status bar, following a proof request, Nori's page layout and look                                                                           |
| `.env`, `env.ts`    | Public build constants: Ethereum chain id and RPC, proof queue and its deploy block, `NoriSnapshot`, the token bridge, Tempo chain id and RPCs, Nori bridge, Nori's websocket, the migrated ERC-20 |

```sh
npm run dev -w web/apps/migrate         # http://localhost:5180
npm run dev -w web/dashboards/bridge    # http://localhost:7400
```

`build`, `build:ssg` (static pages) and `preview` work the same way. They need
`NORI_TEMPO_TOKEN_BRIDGE_ADDRESS` (the Nori bridge on Moderato), `NORI_ETH_TOKEN_BRIDGE_ADDRESS`
(its `NoriTokenBridge` on Sepolia) and `NORI_WEB_MIGRATION_TOKEN` (the ERC-20,
`scripts/deploy-migration.sh`) in `web/.env`. After a redeploy, update the addresses in
`web/.env` (committed: public values only; everything in it reaches the browser).

## Migrate

Connect an Ethereum wallet. The app asks you to install MetaMask if you have none, to pick
one if you have several, and to switch to Sepolia if needed. Above the form, the token on
both chains: paused or not on Ethereum and on Tempo, locked by everyone against minted by
Nori (reconciled: minted never exceeds locked), your balances, and whether the TIP-20 is
the issuer's own (the issuer keeps its admin) or one the bridge created.

Enter an amount (at most 6 decimals, a TIP-20's) and the Tempo recipient, your account by
default. The app reads your balance and allowance, the token's pause and the bridge's quote
(`previewLockERC20`: the rate fee and the proof queue fee). "Lock on Ethereum" asks your
wallet onto Sepolia, approves the bridge if the allowance falls short, and sends
`lockERC20`. The lock is followed as a proof request: found on Ethereum, waiting for
finality, being proven, and settled in a batch on Tempo. Then "Claim on Tempo" asks your
wallet onto Tempo and sends `mintERC20` with the lock's witness, signed by the recipient
(only it can claim). A paused token, a balance that falls short, a declined signature or a
dropped connection is shown, and you carry on from there.

Ethereum reads go through `ETH_RPC_URL` first, so they go on while the wallet is on Tempo
for a claim; the Tempo wallet uses the wallet chosen for Ethereum.

## Bridge dashboard

Batches Nori has settled on Tempo, newest first. Above them, the requests no batch covers
yet, in three rows: waiting for Ethereum finality, scheduled for processing, and processing
in Nori's current job, each with a countdown. Open a batch or a row to see its requests,
each with the submitting contract and the enqueuing transaction, linked to Etherscan.

Requests from `NoriSnapshot` (Backstop's reads) and `NoriTokenBridge` (migration locks and
pause syncs) are named. Filter by contract in the box, or share a filtered view as
`?target=<address>`.
`?synthetic` fills the waiting rows with made-up requests, to preview the layout.

Conventions, toolchain and editor setup for this folder: [AGENTS.md](AGENTS.md).
