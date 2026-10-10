# Tempo's migration guide, mapped to Nori

Tempo's [Migrate an ERC-20 to TIP-20](https://tempo.xyz/developers/docs/guide/issuance/migrate-erc20-to-tip20)
gives four paths. Nori is the third, the **bridge adapter**: the ERC-20 stays canonical on
Ethereum, its holders lock it there, and an adapter with `ISSUER_ROLE` mints the TIP-20 on
Tempo. What the guide leaves to a trusted operator (the adapter's accounting, a sync
signer) Nori does with a proof of Ethereum's finalized state.

| Path (the guide's table) | Use when                                   | Nori                                                                          |
| ------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------- |
| Native TIP-20 launch     | New issuance on Tempo                      | Not needed                                                                    |
| ERC-20 migration         | Existing supply moves to Tempo             | The same flow: holders lock (retire) on Ethereum and claim on Tempo           |
| **Bridge adapter**       | **The ERC-20 stays canonical on Ethereum** | **This repo**: `NoriTokenBridge` on Ethereum, `NoriTempoTokenBridge` on Tempo |
| Lifecycle manager        | Subscriptions, redemptions, caps, oracles  | Out of scope; such a manager could hold `ISSUER_ROLE` next to the bridge      |

## The checklist

From the guide's implementation checklist, for the demo's DUSD (`DemoIssuerToken`, an
OpenZeppelin `ERC20` + `AccessControl` + `Pausable` + `Burnable` with 18 decimals, the
guide's starting point):

| The guide                                  | Here                                                                                                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TIP-20 deployed through `TIP20Factory`     | The issuer runs `createToken` (nori-tempo-sdk task `createIssuerTip20`, or `scripts/deploy-migration.sh`)                                                                        |
| Admin controlled by the issuer             | The issuer keeps `DEFAULT_ADMIN_ROLE`; `adoptMirror` registers the TIP-20 without taking it. A mirror the bridge creates itself (`registerMirror`) is the other option           |
| `ISSUER_ROLE` only to the adapter          | The issuer grants it to `NoriTempoTokenBridge`; `adoptMirror` checks it with TIP-20's `hasRole(account, role)` (account first)                                                   |
| `PAUSE_ROLE` and `UNPAUSE_ROLE` assigned   | Granted to the bridge too, so the ERC-20's pause reaches the TIP-20. The issuer can hold them as well; an Ethereum unpause then also lifts a Tempo-only pause                    |
| Supply cap set deliberately                | The issuer sets it. A mint over the cap reverts and the recipient claims again once raised (tested)                                                                              |
| Transfer policy if compliance is required  | The issuer's TIP-403 policy applies to Nori's mints like any other (mint-recipient check). Proving an Ethereum allow or block list onto it is the roadmap                        |
| Legacy supply burned, locked or reconciled | Locked in `NoriTokenBridge`, no unlock path. `migrate status` and the app reconcile `totalLockedERC20BU` (Ethereum) against `erc20TotalMinted` (Tempo)                           |
| Decimal conversion tested                  | 18 → 6: one TIP-20 unit is 10¹² DUSD base units. `lockERC20` refuses dust (`InvalidTokenUnitMultiple`, tested in `ethereum/test/DemoIssuerToken.ts`) and tokens under 6 decimals |
| Mint tests cover the supply cap and pause  | nori-tempo-sdk `tempo/test`: cap, pause, a revoked `ISSUER_ROLE`, only the committed recipient, only the new amount each time                                                    |
| Pause blocks transfers, mints and burns    | A paused TIP-20 refuses transfers (`ContractPaused()`, `scripts/migrate-dry-run.sh` step 4) and, by TIP-20's pause rules, mints, so claims wait for the unpause                  |
| An operational runbook                     | nori-tempo-sdk `DEPLOYMENT.md` §5 (mirrors), this repo's `scripts/deploy-migration.sh` and `client/README.md`                                                                    |

Receive policies: a recipient's own policy can redirect a mint to `ReceivePolicyGuard` as
a claimable receipt (the guide's note). The bridge counts it as minted; the recipient
claims it from the guard.

## The sync signer, replaced

The guide's compliance flow has an issuer service ("simple-policy admin / sync signer")
copy wallet eligibility from the issuer's systems into Tempo's TIP-403 registry. The
pause is the same kind of state, and Nori carries it without a signer:

1. The issuer pauses the ERC-20 on Ethereum.
2. Anyone calls `NoriTokenBridge.syncPause(token)`, paying the proof queue fee: it copies
   `paused()` into the bridge's storage and enqueues a proof request for that slot.
3. Nori proves the batch (Ethereum finality, then Helios in SP1, then `update` on Tempo).
4. Anyone calls `NoriTempoTokenBridge.applyPause(witness, batch)`: the bridge pauses or
   unpauses the TIP-20. Only a batch newer than the last one applied counts, so an old
   proof cannot undo a newer state.

The relayers (`npm run migrate -w client -- run`) hold no authority: they can delay a
pause by not relaying it, never forge one. The same path could carry an issuer's Ethereum
allow or block list to a TIP-403 policy whose admin is the bridge (roadmap, not built).

## Lock or burn

Today `lockERC20` locks: the tokens sit in `NoriTokenBridge`, which has no unlock function
(`unlockTokens` reverts) and no rescue path, so the supply is retired on Ethereum,
although `totalSupply()` there still counts it. An issuer that wants it burned changes how
`lockERC20` takes the tokens, for a token with `burnFrom` (OpenZeppelin `ERC20Burnable`, as
DUSD has):

```solidity
// lock (today): pull the tokens, and check that exactly `amount` arrived
uint256 balanceBefore = IERC20(token).balanceOf(address(this));
IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
uint256 received = IERC20(token).balanceOf(address(this)) - balanceBefore;
if (received != amount) revert TransferAmountMismatch(amount, received);

// burn instead: burn the net, pull only the rate fee the bridge keeps, and check
// that exactly the net left the supply (the holder approves the bridge as before)
uint256 supplyBefore = IERC20(token).totalSupply();
ERC20Burnable(token).burnFrom(msg.sender, netBU * tokenUnit);
uint256 burned = supplyBefore - IERC20(token).totalSupply();
if (burned != netBU * tokenUnit) revert TransferAmountMismatch(netBU * tokenUnit, burned);
if (feeBU > 0) IERC20(token).safeTransferFrom(msg.sender, address(this), feeBU * tokenUnit);
```

The rest stays as it is: the bridge still credits `lockedERC20[token][codeChallenge]`,
that slot is still what Nori proves, and nothing on Tempo changes. A token whose burn needs
a role (`BURNER_ROLE`) grants it to the bridge instead of an allowance.
