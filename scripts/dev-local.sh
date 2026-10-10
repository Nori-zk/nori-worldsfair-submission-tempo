#!/usr/bin/env bash
# The web apps on local chains: a Hardhat fork of Ethereum and
# `anvil --network tempo` with every contract deployed (local-chains.sh), the
# prove-balance app and the bridge dashboard pointed at them, and fake-prover
# settling the waiting proof requests into a batch on Tempo every few seconds,
# as Nori's prover would.
#
# Usage: scripts/dev-local.sh [--eth-rpc URL] [--tempo-rpc URL] [--prove-every SECS]
#   --eth-rpc URL        Ethereum chain the local node forks (default: Sepolia,
#                        publicnode)
#   --tempo-rpc URL      Tempo chain the local node forks (default: offline)
#   --prove-every SECS   seconds between fake-prover runs (default: 15)
#
# Ctrl-C stops everything. scripts/outage.sh freezes and resumes a chain while
# it runs. Uses ports 18545, 18546, 5180 and 7400.

set -euo pipefail

KEEP=0
PROVE_EVERY=15
ETH_FORK_RPC=${ETH_FORK_RPC:-https://ethereum-sepolia-rpc.publicnode.com}
TEMPO_FORK_RPC=${TEMPO_FORK_RPC:-}
usage() { echo "Usage: $0 [--eth-rpc URL] [--tempo-rpc URL] [--prove-every SECS]"; exit 1; }
while [ $# -gt 0 ]; do
    case "$1" in
        --eth-rpc) ETH_FORK_RPC=${2:?--eth-rpc needs a URL}; shift ;;
        --tempo-rpc) TEMPO_FORK_RPC=${2:?--tempo-rpc needs a URL}; shift ;;
        --prove-every) PROVE_EVERY=${2:?--prove-every needs seconds}; shift ;;
        *) usage ;;
    esac
    shift
done

. "$(dirname "$0")/local-chains.sh"
EXTRA_PORTS=(5180 7400)

check_local
start_chains
deploy_contracts
write_keeper_config

say "The Nori bridge's position (fake-prover), then the demo guard"
prove
keeper create-guards

# The apps' build constants (web/env.ts): the shell wins over web/.env.
# NORI_WEB_BRIDGE_WSS_URL stays web/.env's; no Nori websocket runs locally.
export ETH_CHAIN_ID=$(cast chain-id --rpc-url "$ETH_URL")
export TEMPO_CHAIN_ID=$(cast chain-id --rpc-url "$TEMPO_URL")
export TEMPO_WSS_NETWORK_URL=ws://127.0.0.1:18546
export NORI_WEB_PROOF_QUEUE_DEPLOY_BLOCK=$ETH_START_BLOCK

say "Starting the apps (logs in $W)"
(cd "$REPO" && exec npm run dev -w web/apps/prove-balance) >"$W/prove-balance.log" 2>&1 &
PIDS+=($!)
(cd "$REPO" && exec npm run dev -w web/dashboards/bridge) >"$W/bridge-dashboard.log" 2>&1 &
PIDS+=($!)
wait_for "prove-balance" "curl -sf -o /dev/null http://localhost:5180"
wait_for "bridge dashboard" "curl -sf -o /dev/null http://localhost:7400"

# Each round the keeper snapshots the demo lockbox, enqueuing a proof request,
# and fake-prover settles what is waiting, so batches keep arriving
(while sleep "$PROVE_EVERY"; do keeper snapshot && prove; done >>"$W/fake-prover.log") &
PIDS+=($!)

cat <<EOF

${bold}Running${reset}
  prove-balance      http://localhost:5180
  bridge dashboard   http://localhost:7400
  Ethereum           $ETH_URL (chain $ETH_CHAIN_ID)
  Tempo              $TEMPO_URL (chain $TEMPO_CHAIN_ID)
  fake-prover        every ${PROVE_EVERY}s, log $W/fake-prover.log

${bold}Wallet${reset}
  Add the network: RPC $ETH_URL, chain id $ETH_CHAIN_ID.
  Import test key 0, funded on the fork: $DEV_KEY

${bold}Outages${reset} (the chain keeps its state while frozen)
  npm run outage -- eth down     npm run outage -- eth up
  npm run outage -- tempo down   npm run outage -- tempo up
  Wrong network: switch the wallet to any other chain.

${bold}Contracts${reset}
  NoriProofRequestQueue   $NORI_ETH_PROOF_QUEUE_ADDRESS (from block $ETH_START_BLOCK)
  NoriSnapshot            $NORI_ETH_SNAPSHOT_ADDRESS
  NoriTokenBridge         $NORI_ETH_TOKEN_BRIDGE_ADDRESS
  NoriTempoTokenBridge    $NORI_TEMPO_TOKEN_BRIDGE_ADDRESS
  Keeper config           $W/keeper.json

Ctrl-C stops everything.
EOF

wait
