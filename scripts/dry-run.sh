#!/usr/bin/env bash
# The whole Nori read loop on local chains, with a fake prover:
#
#   Sepolia fork (Hardhat) -> keeper snapshot -> fake-prover "proves" the batch
#   -> keeper submitRead -> Backstop guard on a local Tempo node
#
# Replays the Kelp drain on a demo lockbox: HEALTHY, then TRIPPED, then still
# TRIPPED after a refill. When the lockbox pauses, the keeper syncs its pause
# through the token bridge and applies it to the lockbox's TIP-20 mirror.
# fake-prover proves nothing; it writes the batches into the Nori bridge's
# storage as the real prover's `update` would.
#
# Usage: scripts/dry-run.sh [--eth-rpc URL] [--tempo-rpc URL] [--yes] [--keep]
#   --eth-rpc URL     Ethereum chain the local node forks (default: Sepolia,
#                     publicnode). A mainnet URL forks mainnet instead.
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
ETH_FORK_RPC=${ETH_FORK_RPC:-https://ethereum-sepolia-rpc.publicnode.com}
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

REPO=$(cd "$(dirname "$0")/.." && pwd)
W=$(mktemp -d "${TMPDIR:-/tmp}/nori-dry-run.XXXXXX")  # GNU and BSD mktemp
ETH_URL=http://127.0.0.1:18545
TEMPO_URL=http://127.0.0.1:18546
# Hardhat's and anvil's public test key 0
DEV_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# Ethereum tasks: the local fork, test key 0, outputs in $W
export ETH_NETWORK=localfork ETH_RPC_URL=$ETH_URL NORI_ETH_ENV_DIR=$W
export ETH_PRIVATE_KEY=$DEV_KEY
# Set (even empty) wins over .env: the dry run deploys its own queue
export NORI_ETH_PROOF_QUEUE_ADDRESS= NORI_ETH_SNAPSHOT_QUEUE_OPERATOR_ADDRESS= \
    NORI_ETH_SNAPSHOT_QUEUE_FEE_RECIPIENT_ADDRESS= NORI_ETH_SNAPSHOT_PROOF_REQUEST_QUEUE_FEE_WEI=0
# Tempo tasks and the keeper: the local node's unlocked dev accounts, test key 0, outputs in $W
export TEMPO_NETWORK=localnet TEMPO_RPC_NETWORK_URL=$TEMPO_URL NORI_TEMPO_ENV_DIR=$W
export TEMPO_PRIVATE_KEY=$DEV_KEY

bold=$(tput bold 2>/dev/null || true)
reset=$(tput sgr0 2>/dev/null || true)
say() { echo; echo "${bold}== $*${reset}"; }
step() {
    say "$*"
    if [ "$YES" = 0 ]; then read -r -p "   press Enter to run " _; fi
}
quiet() { "$@" 2>&1 | grep -vE "ExperimentalWarning|trace-warnings|^\s*$" || true; }

PIDS=()
cleanup() {
    if [ "$KEEP" = 1 ]; then
        echo; echo "Chains left running (pids ${PIDS[*]:-}); work dir $W"
        return
    fi
    # npx runs the Hardhat node a level below its own pid, so the nodes are
    # also stopped by the ports they hold
    for pid in "${PIDS[@]:-}"; do
        [ -n "$pid" ] || continue
        pkill -P "$pid" 2>/dev/null || true
        kill "$pid" 2>/dev/null || true
    done
    for pid in $(lsof -t -i :18545 -i :18546 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
    rm -rf "$W"
}
trap cleanup EXIT

wait_for() {
    local name=$1 check=$2
    for _ in $(seq 1 90); do
        if eval "$check" >/dev/null 2>&1; then return 0; fi
        sleep 1
    done
    echo "$name did not start; logs in $W"; exit 1
}

for tool in anvil cast npx; do
    command -v "$tool" >/dev/null || { echo "Missing: $tool"; exit 1; }
done
[ -d "$REPO/client/build" ] || { echo "Run 'npm install && npm run build' first"; exit 1; }
for port in 18545 18546; do
    if lsof -i ":$port" >/dev/null 2>&1; then echo "Port $port is busy"; exit 1; fi
done

# --------------------------------------------------------------------------
say "Starting chains (logs in $W)"
(cd "$REPO/ethereum" && ETH_NETWORK=hardhat exec npx hardhat node --fork "$ETH_FORK_RPC" --port 18545) >"$W/ethereum.log" 2>&1 &
PIDS+=($!)
# A fork keeps the local chain id, which deployNoriBridge requires
if [ -n "$TEMPO_FORK_RPC" ]; then TEMPO_SOURCE=(--fork-url "$TEMPO_FORK_RPC" --chain-id 31337); else TEMPO_SOURCE=(); fi
anvil --network tempo --port 18546 "${TEMPO_SOURCE[@]}" >"$W/tempo.log" 2>&1 &
PIDS+=($!)
wait_for "Ethereum fork" "cast chain-id --rpc-url $ETH_URL"
wait_for "Tempo node" "cast chain-id --rpc-url $TEMPO_URL"
# A fork's clock starts behind real time; the guard compares it with Tempo's
cast rpc evm_setNextBlockTimestamp "$(date +%s)" --rpc-url "$ETH_URL" >/dev/null
cast rpc evm_mine --rpc-url "$ETH_URL" >/dev/null
echo "Ethereum: fork of chain $(cast chain-id --rpc-url "$ETH_FORK_RPC") ($ETH_FORK_RPC) on $ETH_URL"
echo "Tempo: anvil --network tempo on $TEMPO_URL, state from ${TEMPO_FORK_RPC:-nowhere (offline)}"

say "Building the contracts and the client"
(cd "$REPO" && npm run -s build -w ethereum -w tempo -w client >/dev/null)

say "Ethereum: deploying the proof queue, NoriSnapshot, a lockbox holding 116,723.52 and a token bridge on that queue"
(cd "$REPO/ethereum" && quiet npx hardhat --network localfork deploy | grep -oE "(NoriProofRequestQueue|NoriSnapshot) deployed to: 0x[0-9a-fA-F]+")
(cd "$REPO/ethereum" && quiet npx hardhat --network localfork deployDemo 116723.52 | grep -oE "DemoLockbox deployed to 0x[0-9a-fA-F]+")
set -a
. "$W/.env.nori-eth-snapshot"
. "$W/.env.nori-eth-demo"
set +a
(cd "$REPO/ethereum" && quiet npx hardhat --network localfork deployNoriTokenBridge "$NORI_ETH_PROOF_QUEUE_ADDRESS" | grep -oE "NoriTokenBridge deployed to: 0x[0-9a-fA-F]+")
set -a
. "$W/.env.nori-eth-token-bridge"
set +a

say "Tempo: deploying the Nori bridge proving that queue, with a mirror of the lockbox, Backstop and a demo token with supply 116,700"
(cd "$REPO/tempo" && quiet npx hardhat --network localnet deployNoriBridge "$NORI_ETH_PROOF_QUEUE_ADDRESS" "$NORI_ETH_TOKEN_BRIDGE_ADDRESS" --mirror "$NORI_ETH_DEMO_LOCKBOX_ADDRESS" | grep -oE "(NoriTempoTokenBridge|Mirror of) 0x[0-9a-fA-F]+(: 0x[0-9a-fA-F]+)?")
(cd "$REPO/tempo" && quiet npx hardhat --network localnet deploy | grep -oE "Backstop deployed to: 0x[0-9a-fA-F]+")
(cd "$REPO/tempo" && quiet npx hardhat --network localnet deployDemo 116700 | grep -oE "Demo token 0x[0-9a-fA-F]+")
set -a
. "$W/.env.nori-tempo-bridge"
. "$W/.env.nori-tempo-backstop"
. "$W/.env.nori-tempo-demo"
set +a

cat >"$W/keeper.json" <<EOF
{
  "ethereum": { "rpcUrl": "$ETH_URL", "noriSnapshot": "$NORI_ETH_SNAPSHOT_ADDRESS", "proofQueue": "$NORI_ETH_PROOF_QUEUE_ADDRESS", "tokenBridge": "$NORI_ETH_TOKEN_BRIDGE_ADDRESS" },
  "tempo": { "rpcUrl": "$TEMPO_URL", "bridge": "$NORI_TEMPO_TOKEN_BRIDGE_ADDRESS", "backstop": "$NORI_TEMPO_BACKSTOP_ADDRESS" },
  "intervals": { "snapshotSecs": 120, "checkpointSecs": 10, "pollSecs": 15 },
  "stateFile": "$W/keeper-state.json",
  "guards": [{
    "name": "demo-lockbox", "token": "$BACKSTOP_DEMO_TOKEN",
    "backing": { "target": "$NORI_ETH_DEMO_LOCKBOX_ADDRESS", "signature": "locked()", "args": [] },
    "pause": { "target": "$NORI_ETH_DEMO_LOCKBOX_ADDRESS", "signature": "paused()", "args": [] },
    "backingDecimals": 18, "tolerance": "1000000",
    "windowSecs": 600, "skewSecs": 5, "checkpointIntervalSecs": 5, "maxStalenessSecs": 7200
  }],
  "mirrors": [{ "name": "lockbox-mirror", "ethToken": "$NORI_ETH_DEMO_LOCKBOX_ADDRESS" }]
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

step "5. The attacker refills to 40,300 and the lockbox pauses: it stays tripped, and its mirror on Tempo pauses"
demo_set 40300 --paused
sleep 6
keeper snapshot
keeper sync-pauses
prove
keeper submit
keeper apply-pauses
expect_status "TRIPPED .*paused true"
if ! keeper status | grep -E "lockbox-mirror: ERC-20 paused true \| mirror 0x[0-9a-fA-F]+ paused true"; then
    echo "Expected the lockbox's mirror paused"; exit 1
fi

say "Done: HEALTHY -> TRIPPED on the drain -> still TRIPPED after the refill; the mirror follows the pause"
