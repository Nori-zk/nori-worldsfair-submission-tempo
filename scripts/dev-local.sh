#!/usr/bin/env bash
# The web apps on local chains: a Hardhat fork of Ethereum and
# `anvil --network tempo` with every contract deployed (local-chains.sh), the
# prove-balance app, the migrate app and the bridge dashboard pointed at them,
# and fake-prover settling the waiting proof requests into a batch on Tempo
# every few seconds, as Nori's prover would, while the keeper carries DUSD's
# pause to its TIP-20.
#
# Usage: scripts/dev-local.sh [--eth-rpc URL | --offline] [--tempo-rpc URL] [--prove-every SECS]
#   --eth-rpc URL        Ethereum chain the local node forks (default: Sepolia,
#                        publicnode)
#   --offline            a fresh local Ethereum chain instead of a fork
#   --tempo-rpc URL      Tempo chain the local node forks (default: offline)
#   --prove-every SECS   seconds between fake-prover runs (default: 15)
#
# Ctrl-C stops everything. scripts/outage.sh freezes and resumes a chain while
# it runs. Uses ports 18545, 18546, 5180, 5181 and 7400. DUSD and the migrate
# app need the Nori bridge with adoptMirror (local-chains.sh,
# use_bridge_with_adopt); without it prove-balance and the dashboard run alone.
#
# Tempo transactions (the migrate app's claim) pay their fee in a USD TIP-20:
# the test keys hold pathUSD on the local Tempo node.

set -euo pipefail

KEEP=0
PROVE_EVERY=15
ETH_FORK_RPC=${ETH_FORK_RPC:-https://ethereum-sepolia-rpc.publicnode.com}
TEMPO_FORK_RPC=${TEMPO_FORK_RPC:-}
usage() { echo "Usage: $0 [--eth-rpc URL | --offline] [--tempo-rpc URL] [--prove-every SECS]"; exit 1; }
while [ $# -gt 0 ]; do
    case "$1" in
        --eth-rpc) ETH_FORK_RPC=${2:?--eth-rpc needs a URL}; shift ;;
        --offline) ETH_FORK_RPC= ;;
        --tempo-rpc) TEMPO_FORK_RPC=${2:?--tempo-rpc needs a URL}; shift ;;
        --prove-every) PROVE_EVERY=${2:?--prove-every needs seconds}; shift ;;
        *) usage ;;
    esac
    shift
done

. "$(dirname "$0")/local-chains.sh"
MIGRATION=0
EXTRA_PORTS=(5180 7400)
if use_bridge_with_adopt; then
    MIGRATION=1
    EXTRA_PORTS+=(5181)
fi

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
MIGRATE_AT="off (no Nori bridge with adoptMirror, see the start)"
if [ "$MIGRATION" = 1 ]; then
    export NORI_WEB_MIGRATION_TOKEN=$NORI_ETH_ISSUER_TOKEN_ADDRESS
    (cd "$REPO" && exec npm run dev -w web/apps/migrate) >"$W/migrate.log" 2>&1 &
    PIDS+=($!)
    MIGRATE_AT=http://localhost:5181
else
    export NORI_WEB_MIGRATE_URL=  # the nav leaves out the link to the app that is not running
fi
(cd "$REPO" && exec npm run dev -w web/apps/prove-balance) >"$W/prove-balance.log" 2>&1 &
PIDS+=($!)
(cd "$REPO" && exec npm run dev -w web/dashboards/bridge) >"$W/bridge-dashboard.log" 2>&1 &
PIDS+=($!)
wait_for "prove-balance" "curl -sf -o /dev/null http://localhost:5180"
[ "$MIGRATION" = 0 ] || wait_for "migrate" "curl -sf -o /dev/null http://localhost:5181"
wait_for "bridge dashboard" "curl -sf -o /dev/null http://localhost:7400"

# Each round the keeper snapshots the demo lockbox and syncs any pause that
# changed (DUSD's issuer pausing it), enqueuing proof requests; fake-prover
# settles what is waiting, locks included, so batches keep arriving; then the
# keeper applies each proven pause on Tempo
(while sleep "$PROVE_EVERY"; do keeper snapshot && keeper sync-pauses && prove && keeper apply-pauses; done >>"$W/fake-prover.log") &
PIDS+=($!)

cat <<EOF

${bold}Running${reset}
  prove-balance      http://localhost:5180
  migrate            $MIGRATE_AT
  bridge dashboard   http://localhost:7400
  Ethereum           $ETH_URL (chain $ETH_CHAIN_ID)
  Tempo              $TEMPO_URL (chain $TEMPO_CHAIN_ID)
  fake-prover        every ${PROVE_EVERY}s, log $W/fake-prover.log

${bold}Wallet${reset}
  Add the networks: Ethereum RPC $ETH_URL, chain id $ETH_CHAIN_ID;
  Tempo RPC $TEMPO_URL, chain id $TEMPO_CHAIN_ID (the migrate app claims there).
  Import test key 2, funded on both: $HOLDER_KEY
  (not key 0: the deploys, the keeper and the snapshots sign with it, so its nonces move under the wallet)
EOF
if [ "$MIGRATION" = 1 ]; then
    cat <<EOF

${bold}Migration${reset}
  Test key 2 holds 1,000,000 DUSD $NORI_ETH_ISSUER_TOKEN_ADDRESS; its TIP-20 on Tempo is $NORI_TEMPO_MIRROR_ADDRESS.
  The issuer pauses or unpauses DUSD on Ethereum; the keeper carries it to Tempo:
  (cd ethereum && ETH_NETWORK=localfork ETH_RPC_URL=$ETH_URL ETH_PRIVATE_KEY=$ISSUER_KEY NORI_ETH_ISSUER_TOKEN_ADDRESS=$NORI_ETH_ISSUER_TOKEN_ADDRESS npx hardhat --network localfork issuerPause [--unpause])
EOF
fi
cat <<EOF

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
