#!/usr/bin/env bash
# Backstop on Tempo, the whole read loop on local chains, with a fake prover:
#
#   Ethereum (Hardhat) -> keeper snapshot -> fake-prover "proves" the batch
#   -> keeper submitRead -> Backstop guard on a local Tempo node
#
# Replays the Kelp drain on a demo lockbox: HEALTHY, then TRIPPED, then still
# TRIPPED after a refill and a pause. fake-prover proves nothing; it writes
# the batches into the Nori bridge's storage as the real prover's `update`
# would. Backstop's live showcase runs on Solana (nori-worldsfair-submission);
# this is the same guard on Tempo. The migration demo is
# scripts/migrate-dry-run.sh.
#
# Usage: scripts/dry-run.sh [--eth-rpc URL | --offline] [--tempo-rpc URL] [--yes] [--keep]
#   --eth-rpc URL     Ethereum chain the local node forks (default: Sepolia,
#                     publicnode). A mainnet URL forks mainnet instead.
#   --offline         a fresh local Ethereum instead of a fork
#   --tempo-rpc URL   Tempo chain the local node forks, e.g.
#                     https://rpc.moderato.tempo.xyz (default: offline).
#                     Tempo always runs locally: fake-prover needs anvil's
#                     anvil_setStorageAt.
#   --yes             run straight through, no pauses (exits non-zero if a
#                     status is wrong)
#   --keep            leave both chains running at the end
#
# ETH_FORK_RPC and TEMPO_FORK_RPC work as defaults for the two URLs.
#
# Needs: npm install && npm run build (once), anvil and cast (Foundry, with
# `anvil --network tempo`).
# Uses ports 18545 (Ethereum) and 18546 (Tempo), and a temp dir; it ignores
# your .env.

set -euo pipefail

YES=0
KEEP=0
ETH_FORK_RPC=${ETH_FORK_RPC-https://ethereum-sepolia-rpc.publicnode.com}
TEMPO_FORK_RPC=${TEMPO_FORK_RPC:-}
usage() { echo "Usage: $0 [--eth-rpc URL | --offline] [--tempo-rpc URL] [--yes] [--keep]"; exit 1; }
while [ $# -gt 0 ]; do
    case "$1" in
        --eth-rpc) ETH_FORK_RPC=${2:?--eth-rpc needs a URL}; shift ;;
        --offline) ETH_FORK_RPC= ;;
        --tempo-rpc) TEMPO_FORK_RPC=${2:?--tempo-rpc needs a URL}; shift ;;
        --yes) YES=1 ;;
        --keep) KEEP=1 ;;
        *) usage ;;
    esac
    shift
done

. "$(dirname "$0")/lib/local-chains.sh"

# --------------------------------------------------------------------------
start_chains

say "Ethereum: deploying the proof queue, NoriSnapshot and a lockbox holding 116,723.52"
(cd "$REPO/ethereum" && quiet npx hardhat --network localfork deploy | grep -oE "(NoriProofRequestQueue|NoriSnapshot) deployed to: 0x[0-9a-fA-F]+")
(cd "$REPO/ethereum" && quiet npx hardhat --network localfork deployDemo 116723.52 | grep -oE "DemoLockbox deployed to 0x[0-9a-fA-F]+")
set -a
. "$W/.env.nori-eth-snapshot"
. "$W/.env.nori-eth-demo"
set +a

say "Tempo: deploying the Nori bridge proving that queue, Backstop and a demo token with supply 116,700"
(cd "$REPO/tempo" && quiet npx hardhat --network localnet deployNoriBridge "$NORI_ETH_PROOF_QUEUE_ADDRESS" | grep -oE "NoriTempoTokenBridge 0x[0-9a-fA-F]+")
(cd "$REPO/tempo" && quiet npx hardhat --network localnet deploy | grep -oE "Backstop deployed to: 0x[0-9a-fA-F]+")
(cd "$REPO/tempo" && quiet npx hardhat --network localnet deployDemo 116700 | grep -oE "Demo token 0x[0-9a-fA-F]+")
set -a
. "$W/.env.nori-tempo-bridge"
. "$W/.env.nori-tempo-backstop"
. "$W/.env.nori-tempo-demo"
set +a

cat >"$W/keeper.json" <<EOF
{
  "ethereum": { "rpcUrl": "$ETH_URL", "noriSnapshot": "$NORI_ETH_SNAPSHOT_ADDRESS", "proofQueue": "$NORI_ETH_PROOF_QUEUE_ADDRESS" },
  "tempo": { "rpcUrl": "$TEMPO_URL", "bridge": "$NORI_TEMPO_TOKEN_BRIDGE_ADDRESS", "backstop": "$NORI_TEMPO_BACKSTOP_ADDRESS" },
  "intervals": { "snapshotSecs": 120, "checkpointSecs": 10, "pollSecs": 15 },
  "network": { "probeUrls": ["$ETH_URL"] },
  "stateFile": "$W/keeper-state.json",
  "guards": [{
    "name": "demo-lockbox", "token": "$BACKSTOP_DEMO_TOKEN",
    "backing": { "target": "$NORI_ETH_DEMO_LOCKBOX_ADDRESS", "signature": "locked()", "args": [] },
    "pause": { "target": "$NORI_ETH_DEMO_LOCKBOX_ADDRESS", "signature": "paused()", "args": [] },
    "backingDecimals": 18, "tolerance": "1000000",
    "windowSecs": 600, "skewSecs": 5, "checkpointIntervalSecs": 5, "maxStalenessSecs": 7200
  }]
}
EOF
echo "Keeper config: $W/keeper.json"

keeper() { (cd "$REPO/client" && quiet npm run -s keeper -- "$1" "$W/keeper.json"); }
prove() { (cd "$REPO/client" && quiet npm run -s fake-prover -- "$W/keeper.json"); }
demo_set() { (cd "$REPO/ethereum" && quiet npx hardhat --network localfork demoSet "$@" | grep -oE "DemoLockbox: .*\)"); }
expect_status() {
    local out
    out=$(keeper status)
    echo "$out"
    if ! grep -q "demo-lockbox: $1 " <<<"$out"; then echo "Expected $1"; exit 1; fi
}

# --------------------------------------------------------------------------
step "1. The Nori bridge's position (fake-prover), then the guard"
prove
keeper create-guards
sleep 6

step "2. Keeper snapshots the lockbox on Ethereum: locked() and paused() in one transaction"
keeper snapshot
keeper submit

step "3. The batch is proven (fake-prover stands in for bridge-head + update); the keeper submits the reads"
prove
keeper submit
expect_status HEALTHY

step "4. Kelp drain: the lockbox drops to 223.52, then snapshot, prove, submit"
demo_set 223.52
keeper checkpoint
sleep 6
keeper snapshot
prove
keeper submit
expect_status TRIPPED

step "5. The attacker refills to 40,300 and the lockbox pauses: it stays tripped, and the guard shows the pause"
demo_set 40300 --paused
sleep 6
keeper snapshot
prove
keeper submit
expect_status "TRIPPED .*paused true"

say "Done: HEALTHY -> TRIPPED on the drain -> still TRIPPED after the refill and the pause"
