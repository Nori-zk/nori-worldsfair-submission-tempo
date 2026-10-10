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

. "$(dirname "$0")/local-chains.sh"

step() {
    say "$*"
    if [ "$YES" = 0 ]; then read -r -p "   press Enter to run " _; fi
}

check_local
start_chains
deploy_contracts
write_keeper_config

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
