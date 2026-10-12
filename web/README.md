# web: browser apps

Three apps on Sepolia + Tempo Moderato, built with [yaw](https://yaw-rx.github.io/) and
[ystate](https://ystate.github.io/) on the Nori SDK. Each app's flow is a ystate graph,
drawn next to it (`ProveBalanceGraph.svg`, `LockGraph.svg` and `ClaimGraph.svg`, `BridgeBatchesGraph.svg`).

| Package              | What                                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/prove-balance` | Prove on Tempo what an Ethereum address holds: one `NoriSnapshot` transaction from your wallet, followed until a batch on Tempo covers it                   |
| `apps/migrate`       | Migrate an Ethereum ERC-20 to its issuer's TIP-20 on Tempo: lock it on Ethereum from your wallet, follow the proof, claim it on Tempo                        |
| `dashboards/bridge`  | The whole proof queue: every batch Nori has settled on Tempo, the requests still waiting, and the stage Nori's prover is in                                 |
| `libs/ui`            | Shared: wallet and connection buttons, the connection status bar, following a proof request, Nori's page layout and look                                    |
| `.env`, `env.ts`     | Public build constants: Ethereum chain id and RPC, proof queue and its deploy block, `NoriSnapshot`, Tempo chain id and RPCs, Nori bridge, Nori's websocket |

```sh
npm run dev -w web/apps/prove-balance   # http://localhost:5180
npm run dev -w web/apps/migrate         # http://localhost:5181
npm run dev -w web/dashboards/bridge    # http://localhost:7400
```

`build`, `build:ssg` (static pages) and `preview` work the same way. They need
`NORI_TEMPO_TOKEN_BRIDGE_ADDRESS`, the Nori bridge on Moderato, in `web/.env`. The migrate app
also reads `NORI_ETH_TOKEN_BRIDGE_ADDRESS` (the `NoriTokenBridge` it locks in) and
`NORI_WEB_MIGRATION_TOKEN` (the ERC-20 it migrates); while either is empty it builds a page
saying it is not configured, so the root `npm run build` needs neither. After a redeploy,
update the addresses in `web/.env` (committed: public values only; everything in it reaches the browser).

Every page links to the others along its top. When hosting, set each one's hosted address in the
host's build environment: `NORI_WEB_PROVE_BALANCE_URL`, `NORI_WEB_MIGRATE_URL` and `NORI_WEB_DASHBOARD_URL` (`web/.env`
has the dev servers'; an empty `NORI_WEB_MIGRATE_URL` leaves the Migrate link out), and
`NORI_WEB_SOLANA_DASHBOARD_URL`, the Solana submission's bridge dashboard, linked only when set.

## Prove balance

Connect an Ethereum wallet. The app asks you to install MetaMask if you have none, to pick
one if you have several, and to switch to Sepolia if needed. The form starts with your
account and ETH; choose ETH, a listed token or any ERC-20 address, and any holder. The app
reads the balance with the same view call the snapshot will make (ETH through Multicall3's
`getEthBalance`, tokens through `balanceOf`) and shows it with the snapshot fee.

"Prove on Tempo" sends one `NoriSnapshot` transaction, which enqueues a proof request. The
app then follows it: found on Ethereum, waiting for finality, waiting for the batch ahead,
being proven, and settled in a batch on Tempo. A declined signature, a failed read or a
dropped connection is shown, and you carry on from there.

The result: that balance, as of that block, committed by `NoriSnapshot` and proven on
Tempo. Any Tempo contract can verify it with [`NoriRead`](../tempo/README.md).

## Migrate

Move an Ethereum ERC-20 (DUSD in the demo, `NORI_WEB_MIGRATION_TOKEN`) to its issuer's
TIP-20 on Tempo, the bridge adapter path of Tempo's migration guide
([keeper/README.md](../keeper/README.md), "Migration CLI", does the same from Node).
Its page needs `NORI_ETH_TOKEN_BRIDGE_ADDRESS` too, and says it is not configured without both.

1. Connect an Ethereum wallet. Enter an amount (at most 6 decimals: a TIP-20 has 6) and
   the Tempo recipient, your own address by default: only it can claim. The app quotes
   the lock: what you lock, what you claim on Tempo, the bridge fee and the proof queue
   fee. A token its issuer paused, or too small a balance, cannot be locked.
2. "Approve and lock" asks the wallet to approve the bridge first when it may not take
   the amount yet, then to sign `lockERC20`. The lock is for good: the bridge has no
   unlock path.
3. The app follows the lock's proof request, as prove-balance does, until a batch on
   Tempo covers it, then reads the lock's witness.
4. "Claim on Tempo" asks the wallet to switch to Tempo and send `mintERC20` from the
   recipient, which mints everything locked for it and not minted yet. A claim the
   bridge refuses for now (the TIP-20 paused by its issuer) can be sent again.

Below the form, the token across both chains, kept current: locked on Ethereum against
minted on Tempo (never more), the issuer's pause on each chain, and what you hold on
Tempo. `npm run dev:local` runs it on local chains with DUSD deployed and adopted; its
fake prover settles each lock within seconds, and the keeper carries the issuer's pause.

## Bridge dashboard

Batches Nori has settled on Tempo, newest first. Above them, the requests no batch covers
yet, in three rows: waiting for Ethereum finality, scheduled for processing, and processing
in Nori's current job, each with a countdown. Open a batch or a row to see its requests,
each with the submitting contract and the enqueuing transaction, linked to Etherscan.

Filter by contract in the box, or share a filtered view as `?target=<address>`.
`?synthetic` fills the waiting rows with made-up requests, to preview the layout.

Conventions, toolchain and editor setup for this folder: [AGENTS.md](AGENTS.md).
