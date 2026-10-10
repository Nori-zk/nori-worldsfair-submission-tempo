# NoriSnapshot

The proof queue only proves the caller's own storage. `NoriSnapshot` runs any
view calls (up to 256), commits all results under one Merkle root in its own
storage, and enqueues one proof request for it. It has no owner or admin.

## The proven leaf

| Field            | Value                                                 |
| ---------------- | ----------------------------------------------------- |
| `target`         | `NoriSnapshot` address                                |
| `collectionKeys` | `[snapshot index (from 1), block << 64 \| timestamp]` |
| `value`          | `resultsRoot \| 1 << 255`                             |

Result leaf: `sha256(0x00 ++ queryId ++ result)`, where
`queryId = keccak256(abi.encode(target, data))`. The results come from the
`Snapshot` event, which is enough to rebuild any witness.

## A consumer must

- pin the Nori bridge, the `NoriSnapshot` address and its query ids;
- reject stale snapshots, and track the newest block per query (old snapshots stay valid);
- avoid views a flash loan can move within one transaction;
- pin only targets whose views it trusts: Nori proves what a contract returned, so a precompile or an upgradeable contract proves whatever its code (or admin) makes it return.

`NoriRead` ([tempo/](../tempo/README.md)) does the rest. `snapshotProof.ts` is the TS mirror.

## Commands

```sh
npm test                 # unit tests + vector drift check
npm run test:fork        # real mainnet getters on a fork
npm run vectors          # regenerate test-vectors/nori-snapshot
npm run deploy           # NoriSnapshot (+ a fresh queue unless NORI_ETH_PROOF_QUEUE_ADDRESS)
npm run snapshot -- usds-lockbox aave-ntt-hub
npm run snapshot -- --target 0x... --signature 'balanceOf(address)' --args 0x...
npm run preview-snapshot # read-only check of each query
npm run deploy-demo -- 116723.52     # testnet demo: a lockbox you drain by hand
npm run demo-set -- 223.52 [--paused]
npm run deploy-issuer-token -- 1000000 --holder 0x...   # testnet demo: the issuer's ERC-20 to migrate (DUSD)
npm run issuer-pause [-- --unpause]  # as its issuer: pause it, and so its TIP-20 on Tempo once proven
```

Config: the repo's `.env` (`../.env.example`). `deploy` writes `.env.nori-eth-snapshot`,
`deploy-demo` writes `.env.nori-eth-demo`, `deploy-issuer-token` writes
`.env.nori-eth-migration`; the later commands, the keeper and the migration CLI read them.

## The issuer's ERC-20

`DemoIssuerToken` (`contracts/demo/`) is the ERC-20 Tempo's migration guide starts from:
OpenZeppelin `ERC20`, `AccessControl` (admin, minter, pauser), `Pausable` and `Burnable`,
18 decimals. Its tests run it through nori-tempo-sdk's real `NoriTokenBridge`: 18 decimals
locked as 6-decimal bridge units with dust refused, the lock's proven slot, a pause that
blocks locks and `syncPause` that records it for proving ([docs/tempo-migration.md](../docs/tempo-migration.md)).
`contracts/test/Multicall3.sol` is vendored (mds1/multicall3, MIT) for local dry runs,
which plant it at its canonical address on a fresh chain.

## Cost (mainnet fork, queue fee 0)

| Snapshot   | Gas     | ~USD (1.08 gwei, ETH $2,707) |
| ---------- | ------- | ---------------------------- |
| 6 tokens   | 264,587 | $0.77                        |
| 10 queries | 317,908 | $0.93                        |

On Sepolia, which already runs Glamsterdam, a snapshot costs ~730k gas plus ~5.6k per
query (753,817 for a 4-query snapshot): the queue's `requestProof` alone is ~593k, as new
storage got dearer. Expect that on mainnet after its fork; one snapshot for every guard
keeps the fixed cost shared.
