#!/usr/bin/env bash
# An ERC-20 migrated to Tempo on local chains, with a fake prover: the bridge
# adapter path of Tempo's ERC-20 migration guide, with a proof where the
# guide has a sync signer.
#
#   issuer:  DUSD on Ethereum (18 decimals, pausable), and its own TIP-20 on
#            Tempo, which Nori's bridge adopts (the issuer stays its admin)
#   holder:  locks DUSD on Ethereum -> fake-prover "proves" the batch -> claims
#            the TIP-20 on Tempo, 1:1, into the same address
#   issuer:  pauses DUSD on Ethereum -> the keeper syncs the pause, it is
#            proven and applied: the TIP-20 pauses on Tempo; then the unpause
#
# fake-prover proves nothing; it writes the batches into the Nori bridge's
# storage as the real prover's `update` would. Nothing is read from a public
# chain: Ethereum is a fresh local chain unless --eth-rpc forks one.
#
# Usage: scripts/migrate-dry-run.sh [--eth-rpc URL] [--yes] [--keep]
#   --eth-rpc URL   fork this Ethereum chain instead of a fresh local one
#   --yes           run straight through, no pauses (exits non-zero if a
#                   check fails)
#   --keep          leave both chains running at the end
#
# Needs: npm install && npm run build (once), anvil and cast (Foundry, with
# `anvil --network tempo`), and the Nori bridge with adoptMirror
# (@nori-zk/tempo-token-bridge 0.0.3): until that is on npm, a nori-tempo-sdk
# checkout next to this repo (or at NORI_TEMPO_SDK) on that branch.
# Uses ports 18545 (Ethereum) and 18546 (Tempo), and a temp dir; it ignores
# your .env.

set -euo pipefail

YES=0
KEEP=0
ETH_FORK_RPC=${ETH_FORK_RPC:-}
TEMPO_FORK_RPC=
usage() { echo "Usage: $0 [--eth-rpc URL] [--yes] [--keep]"; exit 1; }
while [ $# -gt 0 ]; do
    case "$1" in
        --eth-rpc) ETH_FORK_RPC=${2:?--eth-rpc needs a URL}; shift ;;
        --yes) YES=1 ;;
        --keep) KEEP=1 ;;
        *) usage ;;
    esac
    shift
done

. "$(dirname "$0")/local-chains.sh"

# The public test keys (local-chains.sh): Nori (0, DEV_KEY) deploys the
# bridges and relays pauses, the issuer (1) owns DUSD on both chains, the
# holder (2) migrates

step() {
    say "$*"
    if [ "$YES" = 0 ]; then read -r -p "   press Enter to run " _; fi
}

use_bridge_with_adopt
check_local
start_chains
HOLDER=$(cast wallet address "$HOLDER_KEY")
ISSUER=$(cast wallet address "$ISSUER_KEY")

say "Building the contracts, the keeper and the migration CLI"
(cd "$REPO" && npm run -s build -w ethereum -w tempo -w keeper >/dev/null)

say "Nori deploys its bridges: the proof queue and NoriTokenBridge on Ethereum"
(cd "$REPO/ethereum" && quiet npx hardhat --network localfork deploy | grep -oE "NoriProofRequestQueue deployed to: 0x[0-9a-fA-F]+")
set -a
. "$W/.env.nori-eth-snapshot"
set +a
(cd "$REPO/ethereum" && quiet npx hardhat --network localfork deployNoriTokenBridge "$NORI_ETH_PROOF_QUEUE_ADDRESS" | grep -oE "NoriTokenBridge deployed to: 0x[0-9a-fA-F]+")
set -a
. "$W/.env.nori-eth-token-bridge"
set +a

say "The issuer deploys DUSD on Ethereum (18 decimals, pausable) and mints 1,000,000 to the holder"
deploy_issuer_token "$HOLDER"

say "Tempo: Nori deploys NoriTempoTokenBridge; the issuer creates its own TIP-20 and grants it ISSUER_ROLE, PAUSE_ROLE and UNPAUSE_ROLE; Nori adopts it as DUSD's mirror"
(cd "$REPO/tempo" && quiet npx hardhat --network localnet deployNoriBridge "$NORI_ETH_PROOF_QUEUE_ADDRESS" "$NORI_ETH_TOKEN_BRIDGE_ADDRESS" --adopt "$NORI_ETH_ISSUER_TOKEN_ADDRESS" | grep -oE "(NoriTempoTokenBridge 0x[0-9a-fA-F]+|Mirror of .*)")
set -a
. "$W/.env.nori-tempo-bridge"
set +a
MIRROR=$NORI_TEMPO_MIRROR_ADDRESS

ETH_CHAIN_ID=$(cast chain-id --rpc-url "$ETH_URL")
TEMPO_CHAIN_ID=$(cast chain-id --rpc-url "$TEMPO_URL")
cat >"$W/migration.json" <<EOF
{
  "ethereum": { "rpcUrl": "$ETH_URL", "chainId": "$ETH_CHAIN_ID", "proofQueue": "$NORI_ETH_PROOF_QUEUE_ADDRESS", "tokenBridge": "$NORI_ETH_TOKEN_BRIDGE_ADDRESS" },
  "tempo": { "rpcUrl": "$TEMPO_URL", "chainId": "$TEMPO_CHAIN_ID", "bridge": "$NORI_TEMPO_TOKEN_BRIDGE_ADDRESS" },
  "intervals": { "pollSecs": 15 },
  "stateFile": "$W/migration-state.json",
  "tokens": [{ "name": "dusd", "ethToken": "$NORI_ETH_ISSUER_TOKEN_ADDRESS" }],
  "network": { "probeUrls": ["$ETH_URL", "$TEMPO_URL"] }
}
EOF
# The keeper relays the pause; no Backstop guards here. Both configs probe the
# local nodes for connectivity, so the run needs no internet
cat >"$W/keeper.json" <<EOF
{
  "ethereum": { "rpcUrl": "$ETH_URL", "chainId": "$ETH_CHAIN_ID", "noriSnapshot": "$NORI_ETH_SNAPSHOT_ADDRESS", "proofQueue": "$NORI_ETH_PROOF_QUEUE_ADDRESS", "tokenBridge": "$NORI_ETH_TOKEN_BRIDGE_ADDRESS" },
  "tempo": { "rpcUrl": "$TEMPO_URL", "chainId": "$TEMPO_CHAIN_ID", "bridge": "$NORI_TEMPO_TOKEN_BRIDGE_ADDRESS", "backstop": "0x0000000000000000000000000000000000000000" },
  "intervals": { "snapshotSecs": 120, "checkpointSecs": 10, "pollSecs": 15 },
  "stateFile": "$W/keeper-state.json",
  "guards": [],
  "mirrors": [{ "name": "dusd", "ethToken": "$NORI_ETH_ISSUER_TOKEN_ADDRESS" }],
  "network": { "probeUrls": ["$ETH_URL", "$TEMPO_URL"] }
}
EOF

# The holder's CLI (its key on both chains), Nori's keeper and fake prover
migrate() { (cd "$REPO/keeper" && ETH_PRIVATE_KEY=$HOLDER_KEY TEMPO_PRIVATE_KEY=$HOLDER_KEY quiet npm run -s migrate -- "$@" --config "$W/migration.json"); }
keeper() { (cd "$REPO/keeper" && quiet npm run -s keeper -- "$1" "$W/keeper.json"); }
prove() { (cd "$REPO/keeper" && quiet npm run -s fake-prover -- "$W/migration.json"); }
issuer_pause() { (cd "$REPO/ethereum" && ETH_PRIVATE_KEY=$ISSUER_KEY quiet npx hardhat --network localfork issuerPause "$@" | grep -oE "DemoIssuerToken: .*\)"); }

expect() {
    local out=$1 pattern=$2 what=$3
    echo "$out"
    if ! grep -qE "$pattern" <<<"$out"; then echo "Expected: $what"; exit 1; fi
}

# A transfer on Tempo, simulated as the holder: "true", or the error it reverts with.
CONTRACT_PAUSED=0xab35696f
tempo_transfer() {
    local out
    out=$(cast call "$MIRROR" "transfer(address,uint256)(bool)" "$ISSUER" 1000000 --from "$HOLDER" --rpc-url "$TEMPO_URL" 2>&1 || true)
    if grep -q "$CONTRACT_PAUSED" <<<"$out"; then echo "reverted with ContractPaused()"; else echo "$out"; fi
}

# --------------------------------------------------------------------------
step "1. The holder locks 1,000.5 DUSD on Ethereum for its own address on Tempo (approve, then lockERC20 with the proof queue fee)"
migrate lock dusd 1000.5
expect "$(migrate status)" "minted 0.0 of 1000.5 locked, 1000.5 not claimed yet" "1000.5 locked, nothing minted"

step "2. Before Nori proves it, a claim waits: nothing on Tempo is minted without a proof"
expect "$(migrate claim)" "waiting for Nori to prove it" "the claim waiting for a proof"

step "3. Nori proves the batch (fake-prover stands in for bridge-head + update); the holder claims on Tempo"
prove
migrate claim
expect "$(migrate status)" "minted 1000.5 of 1000.5 locked, reconciled .* holds 1000.5" "1000.5 minted, reconciled with what is locked"

step "4. The issuer pauses DUSD on Ethereum; the keeper syncs it, Nori proves it, the keeper applies it: the TIP-20 pauses on Tempo"
issuer_pause
keeper sync-pauses
prove
keeper apply-pauses
expect "$(keeper status)" "dusd: ERC-20 paused true \| mirror 0x[0-9a-fA-F]+ paused true" "the mirror paused"
expect "A transfer on Tempo while paused: $(tempo_transfer)" "ContractPaused" "the transfer refused"
expect "$(migrate lock dusd 10)" "paused by its issuer" "no lock while paused"

step "5. The issuer unpauses on Ethereum; the same path unpauses the TIP-20, and transfers work again"
issuer_pause --unpause
keeper sync-pauses
prove
keeper apply-pauses
expect "$(keeper status)" "dusd: ERC-20 paused false \| mirror 0x[0-9a-fA-F]+ paused false" "the mirror unpaused"
expect "A transfer on Tempo after the unpause: $(tempo_transfer)" "^A transfer on Tempo after the unpause: true" "the transfer allowed"

say "Done: 1,000.5 DUSD locked on Ethereum = 1,000.5 minted on Tempo, into the issuer's own TIP-20; its pause followed Ethereum both ways, by proof"
