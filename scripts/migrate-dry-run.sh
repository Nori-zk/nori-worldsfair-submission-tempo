#!/usr/bin/env bash
# Migrate an ERC-20 to TIP-20 through Nori, on local chains, with a fake
# prover: Tempo's "bridge adapter" path, where the ERC-20 stays canonical on
# Ethereum and Nori's Tempo bridge mints its TIP-20 against proven locks.
#
#   holder: lockERC20 on Ethereum -> fake-prover "proves" the batch
#   -> holder: mintERC20 on Tempo, into the issuer's own TIP-20
#   issuer: pause on Ethereum -> anyone: syncPause -> proven -> applyPause
#   -> the TIP-20 is paused on Tempo, with no signer copying it
#
# Three dev accounts play three parts: Nori (0) deploys the bridges, the
# issuer (1) owns the ERC-20 on Ethereum and its TIP-20 on Tempo, the holder
# (2) migrates. fake-prover proves nothing; it writes the batches into the
# Nori bridge's storage as the real prover's `update` would.
#
# Usage: scripts/migrate-dry-run.sh [--eth-rpc URL] [--tempo-rpc URL] [--yes] [--keep]
#   --eth-rpc URL     Ethereum chain the local node forks (default: none, a
#                     fresh local chain)
#   --tempo-rpc URL   Tempo chain the local node forks (default: none)
#   --yes             run straight through, no pauses (exits non-zero if a
#                     check fails)
#   --keep            leave both chains running at the end
#
# Needs: npm install && npm run build (once), anvil and cast (Foundry, with
# `anvil --network tempo`). No network access.
# Uses ports 18545 (Ethereum) and 18546 (Tempo), and a temp dir; it ignores
# your .env.

set -euo pipefail

YES=0
KEEP=0
ETH_FORK_RPC=${ETH_FORK_RPC:-}
TEMPO_FORK_RPC=${TEMPO_FORK_RPC:-}
usage() { echo "Usage: $0 [--eth-rpc URL] [--tempo-rpc URL] [--yes] [--keep]"; exit 1; }
while [ $# -gt 0 ]; do
    case "$1" in
        --eth-rpc) ETH_FORK_RPC=${2:?--eth-rpc needs a URL}; shift ;;
        --tempo-rpc) TEMPO_FORK_RPC=${2:?--tempo-rpc needs a URL}; shift ;;
        --yes) YES=1 ;;
        --keep) KEEP=1 ;;
        *) usage ;;
    esac
    shift
done

. "$(dirname "$0")/lib/local-chains.sh"

NORI_KEY=$DEV_KEY
ISSUER_KEY=$DEV_KEY_1
HOLDER_KEY=$DEV_KEY_2

# --------------------------------------------------------------------------
start_chains
ISSUER=$(cast wallet address "$ISSUER_KEY")
HOLDER=$(cast wallet address "$HOLDER_KEY")

say "Ethereum: Nori deploys the proof queue and its token bridge; the issuer deploys its ERC-20 and mints 1,000,000 to the holder"
(cd "$REPO/ethereum" && quiet npx hardhat --network localfork deploy | grep -oE "NoriProofRequestQueue deployed to: 0x[0-9a-fA-F]+")
set -a
. "$W/.env.nori-eth-snapshot"
set +a
(cd "$REPO/ethereum" && quiet npx hardhat --network localfork deployNoriTokenBridge "$NORI_ETH_PROOF_QUEUE_ADDRESS" | grep -oE "NoriTokenBridge deployed to: 0x[0-9a-fA-F]+")
(cd "$REPO/ethereum" && ETH_PRIVATE_KEY=$ISSUER_KEY quiet npx hardhat --network localfork deployIssuerToken 1000000 --holder "$HOLDER" | grep -oE "DemoIssuerToken .*")
set -a
. "$W/.env.nori-eth-token-bridge"
. "$W/.env.nori-eth-migration"
set +a

say "Tempo: Nori deploys its bridge; the issuer creates its own TIP-20 (admin: the issuer) and grants the bridge ISSUER_ROLE, PAUSE_ROLE and UNPAUSE_ROLE; Nori adopts it"
(cd "$REPO/tempo" && quiet npx hardhat --network localnet deployNoriBridge "$NORI_ETH_PROOF_QUEUE_ADDRESS" "$NORI_ETH_TOKEN_BRIDGE_ADDRESS" --adopt "$NORI_ETH_ISSUER_TOKEN_ADDRESS" | grep -oE "(NoriTempoTokenBridge|Mirror of) 0x[0-9a-fA-F]+.*")
set -a
. "$W/.env.nori-tempo-bridge"
set +a

cat >"$W/migration.json" <<EOF
{
  "ethereum": { "rpcUrl": "$ETH_URL", "proofQueue": "$NORI_ETH_PROOF_QUEUE_ADDRESS", "tokenBridge": "$NORI_ETH_TOKEN_BRIDGE_ADDRESS" },
  "tempo": { "rpcUrl": "$TEMPO_URL", "bridge": "$NORI_TEMPO_TOKEN_BRIDGE_ADDRESS" },
  "intervals": { "pollSecs": 5 },
  "network": { "probeUrls": ["$ETH_URL"] },
  "stateFile": "$W/migration-state.json",
  "tokens": [{ "name": "dusd", "ethToken": "$NORI_ETH_ISSUER_TOKEN_ADDRESS" }]
}
EOF
echo "Migration config: $W/migration.json"

# migrate <key> <command> [args]: the key signs on both chains
migrate() {
    local key=$1
    shift
    (cd "$REPO/client" && ETH_PRIVATE_KEY=$key TEMPO_PRIVATE_KEY=$key quiet npm run -s migrate -- "$@" --config "$W/migration.json")
}
prove() { (cd "$REPO/client" && quiet npm run -s fake-prover -- "$W/migration.json"); }
issuer_pause() { (cd "$REPO/ethereum" && ETH_PRIVATE_KEY=$ISSUER_KEY quiet npx hardhat --network localfork issuerPause "$@" | grep -oE "DemoIssuerToken: .*\)"); }
expect() {
    local out=$1 pattern=$2
    if ! grep -qE "$pattern" <<<"$out"; then echo "Expected: $pattern"; exit 1; fi
}
# A transfer of 1 DUSD on Tempo from the holder to the issuer, simulated:
# "true", or the TIP-20's error
tempo_transfer() {
    local out
    out=$(cast call --rpc-url "$TEMPO_URL" --from "$HOLDER" "$NORI_TEMPO_MIRROR_ADDRESS" \
        "transfer(address,uint256)(bool)" "$ISSUER" 1000000 2>&1 | tail -1 || true)
    if grep -q "$(cast sig 'ContractPaused()')" <<<"$out"; then echo "reverted with ContractPaused()"; else echo "$out"; fi
}

# --------------------------------------------------------------------------
step "1. Before: nothing locked on Ethereum, nothing minted on Tempo"
migrate "$HOLDER_KEY" status

step "2. The holder locks 1,000.5 DUSD (18 decimals) on Ethereum for its Tempo address: retired there, no unlock path"
migrate "$HOLDER_KEY" lock dusd 1000.5

step "3. Nori proves the batch (fake-prover stands in for bridge-head + update); the holder claims on Tempo"
prove
migrate "$HOLDER_KEY" claim
out=$(migrate "$HOLDER_KEY" status)
echo "$out"
expect "$out" "minted 1000\.5 of 1000\.5 locked, 0\.0 unclaimed"
expect "$out" "the issuer's own TIP-20"
expect "$out" "holds 1000\.5"

step "4. The issuer pauses DUSD on Ethereum; anyone syncs it, Nori proves it, anyone applies it: the TIP-20 pauses on Tempo"
issuer_pause
migrate "$NORI_KEY" sync-pauses
prove
migrate "$NORI_KEY" apply-pauses
out=$(migrate "$HOLDER_KEY" status)
echo "$out"
expect "$out" "Tempo mirror .* paused true"
transfer=$(tempo_transfer)
echo "A transfer on Tempo while paused: $transfer"
if [ "$transfer" != "reverted with ContractPaused()" ]; then echo "Expected the transfer refused"; exit 1; fi

step "5. The issuer unpauses on Ethereum; the same path unpauses the TIP-20, and transfers work again"
issuer_pause --unpause
migrate "$NORI_KEY" sync-pauses
prove
migrate "$NORI_KEY" apply-pauses
out=$(migrate "$HOLDER_KEY" status)
echo "$out"
expect "$out" "Tempo mirror .* paused false"
transfer=$(tempo_transfer)
echo "A transfer on Tempo after the unpause: $transfer"
if [ "$transfer" != "true" ]; then echo "Expected the transfer allowed"; exit 1; fi

say "Done: 1,000.5 DUSD locked on Ethereum = 1,000.5 minted on Tempo, into the issuer's own TIP-20; its pause followed Ethereum both ways, by proof"
