# Local chains for the scripts, sourced by dry-run.sh and dev-local.sh: a
# Hardhat fork of Ethereum on 18545 and `anvil --network tempo` on 18546,
# with the read loop's contracts deployed on them.
#
# The sourcing script sets ETH_FORK_RPC, TEMPO_FORK_RPC and KEEP (1 leaves the
# chains running at exit), and may add ports to EXTRA_PORTS for cleanup to free.
#
# Needs: npm install && npm run build (once), anvil and cast (Foundry, with
# `anvil --network tempo`). Uses a temp dir; it ignores your .env.

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
W=$(mktemp -d "${TMPDIR:-/tmp}/nori-local.XXXXXX")  # GNU and BSD mktemp
ETH_URL=http://127.0.0.1:18545
TEMPO_URL=http://127.0.0.1:18546
# Hardhat's and anvil's public test key 0
DEV_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
# Foundry's own install dir (foundryup), when it is not on PATH
FOUNDRY_BIN=${FOUNDRY_DIR:-$HOME/.foundry}/bin
[ -d "$FOUNDRY_BIN" ] && export PATH="$PATH:$FOUNDRY_BIN"

# Ethereum tasks: the local fork, test key 0, outputs in $W
export ETH_NETWORK=localfork ETH_RPC_URL=$ETH_URL NORI_ETH_ENV_DIR=$W
export ETH_PRIVATE_KEY=$DEV_KEY
# Set (even empty) wins over .env: the scripts deploy their own queue
export NORI_ETH_PROOF_QUEUE_ADDRESS= NORI_ETH_SNAPSHOT_QUEUE_OPERATOR_ADDRESS= \
    NORI_ETH_SNAPSHOT_QUEUE_FEE_RECIPIENT_ADDRESS= NORI_ETH_SNAPSHOT_PROOF_REQUEST_QUEUE_FEE_WEI=0
# Tempo tasks and the keeper: the local node's unlocked dev accounts, test key 0, outputs in $W
export TEMPO_NETWORK=localnet TEMPO_RPC_NETWORK_URL=$TEMPO_URL NORI_TEMPO_ENV_DIR=$W
export TEMPO_PRIVATE_KEY=$DEV_KEY

bold=$(tput bold 2>/dev/null || true)
reset=$(tput sgr0 2>/dev/null || true)
say() { echo; echo "${bold}== $*${reset}"; }
quiet() { "$@" 2>&1 | grep -vE "ExperimentalWarning|trace-warnings|^\s*$" || true; }

PIDS=()
EXTRA_PORTS=()
cleanup() {
    if [ "$KEEP" = 1 ]; then
        echo; echo "Chains left running (pids ${PIDS[*]:-}); work dir $W"
        return
    fi
    # npx runs the Hardhat node a level below its own pid, so the nodes are
    # also stopped by the ports they hold. A chain frozen by outage.sh is
    # resumed first, so it can exit.
    for pid in "${PIDS[@]:-}"; do
        [ -n "$pid" ] || continue
        pkill -CONT -P "$pid" 2>/dev/null || true
        pkill -P "$pid" 2>/dev/null || true
        kill "$pid" 2>/dev/null || true
    done
    local ports=(-i :18545 -i :18546)
    for port in "${EXTRA_PORTS[@]:-}"; do [ -n "$port" ] && ports+=(-i ":$port"); done
    for pid in $(lsof -t "${ports[@]}" 2>/dev/null); do
        kill -CONT "$pid" 2>/dev/null || true
        kill "$pid" 2>/dev/null || true
    done
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

# Checks the tools, the build and that the ports are free.
check_local() {
    for tool in anvil cast npx lsof; do
        command -v "$tool" >/dev/null || { echo "Missing: $tool"; exit 1; }
    done
    [ -d "$REPO/keeper/build" ] || { echo "Run 'npm install && npm run build' first"; exit 1; }
    for port in 18545 18546 "${EXTRA_PORTS[@]:-}"; do
        [ -n "$port" ] || continue
        if lsof -i ":$port" >/dev/null 2>&1; then echo "Port $port is busy"; exit 1; fi
    done
}

# Starts both chains and sets ETH_START_BLOCK, the fork's block before any deploy.
start_chains() {
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
    ETH_START_BLOCK=$(cast block-number --rpc-url "$ETH_URL")
    echo "Ethereum: fork of chain $(cast chain-id --rpc-url "$ETH_FORK_RPC") ($ETH_FORK_RPC) on $ETH_URL"
    echo "Tempo: anvil --network tempo on $TEMPO_URL, state from ${TEMPO_FORK_RPC:-nowhere (offline)}"
}

# Builds and deploys every contract, and exports their addresses.
deploy_contracts() {
    say "Building the contracts and the keeper"
    (cd "$REPO" && npm run -s build -w ethereum -w tempo -w keeper >/dev/null)

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
}

# Writes $W/keeper.json: the demo guard over the lockbox, and its mirror.
write_keeper_config() {
    cat >"$W/keeper.json" <<EOF
{
  "ethereum": { "rpcUrl": "$ETH_URL", "chainId": "$(cast chain-id --rpc-url "$ETH_URL")", "noriSnapshot": "$NORI_ETH_SNAPSHOT_ADDRESS", "proofQueue": "$NORI_ETH_PROOF_QUEUE_ADDRESS", "tokenBridge": "$NORI_ETH_TOKEN_BRIDGE_ADDRESS" },
  "tempo": { "rpcUrl": "$TEMPO_URL", "chainId": "$(cast chain-id --rpc-url "$TEMPO_URL")", "bridge": "$NORI_TEMPO_TOKEN_BRIDGE_ADDRESS", "backstop": "$NORI_TEMPO_BACKSTOP_ADDRESS" },
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
}

keeper() { (cd "$REPO/keeper" && quiet npm run -s keeper -- "$1" "$W/keeper.json"); }
prove() { (cd "$REPO/keeper" && quiet npm run -s fake-prover -- "$W/keeper.json"); }
demo_set() { (cd "$REPO/ethereum" && quiet npx hardhat --network localfork demoSet "$@" | grep -oE "DemoLockbox: .*\)"); }
