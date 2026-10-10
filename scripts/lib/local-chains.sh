# Shared by scripts/dry-run.sh and scripts/migrate-dry-run.sh: a local
# Ethereum (Hardhat, forking ETH_FORK_RPC when set) on 18545 and a local Tempo
# (`anvil --network tempo`, forking TEMPO_FORK_RPC when set) on 18546, a temp
# work dir, step prompts and cleanup. Source it after setting YES, KEEP,
# ETH_FORK_RPC and TEMPO_FORK_RPC.

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
W=$(mktemp -d "${TMPDIR:-/tmp}/nori-dry-run.XXXXXX") # GNU and BSD mktemp
ETH_URL=http://127.0.0.1:18545
TEMPO_URL=http://127.0.0.1:18546
# Hardhat's and anvil's public test keys 0, 1 and 2
DEV_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
DEV_KEY_1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
DEV_KEY_2=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a

# Ethereum tasks: the local chain, test key 0, outputs in $W
export ETH_NETWORK=localfork ETH_RPC_URL=$ETH_URL NORI_ETH_ENV_DIR=$W
export ETH_PRIVATE_KEY=$DEV_KEY
# Set (even empty) wins over .env: the dry run deploys its own queue
export NORI_ETH_PROOF_QUEUE_ADDRESS= NORI_ETH_SNAPSHOT_QUEUE_OPERATOR_ADDRESS= \
    NORI_ETH_SNAPSHOT_QUEUE_FEE_RECIPIENT_ADDRESS= NORI_ETH_SNAPSHOT_PROOF_REQUEST_QUEUE_FEE_WEI=0
# Tempo tasks and the clients: the local node's unlocked dev accounts, test key 0, outputs in $W
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

# Starts both chains and builds the contracts and the client.
start_chains() {
    for tool in anvil cast npx lsof; do
        command -v "$tool" >/dev/null || { echo "Missing: $tool"; exit 1; }
    done
    [ -d "$REPO/client/build" ] || { echo "Run 'npm install && npm run build' first"; exit 1; }
    for port in 18545 18546; do
        if lsof -i ":$port" >/dev/null 2>&1; then echo "Port $port is busy"; exit 1; fi
    done

    say "Starting chains (logs in $W)"
    if [ -n "$ETH_FORK_RPC" ]; then ETH_SOURCE=(--fork "$ETH_FORK_RPC"); else ETH_SOURCE=(); fi
    (cd "$REPO/ethereum" && ETH_NETWORK=hardhat exec npx hardhat node "${ETH_SOURCE[@]}" --port 18545) >"$W/ethereum.log" 2>&1 &
    PIDS+=($!)
    # A fork keeps the local chain id, which deployNoriBridge requires
    if [ -n "$TEMPO_FORK_RPC" ]; then TEMPO_SOURCE=(--fork-url "$TEMPO_FORK_RPC" --chain-id 31337); else TEMPO_SOURCE=(); fi
    anvil --network tempo --port 18546 "${TEMPO_SOURCE[@]}" >"$W/tempo.log" 2>&1 &
    PIDS+=($!)
    wait_for "Ethereum node" "cast chain-id --rpc-url $ETH_URL"
    wait_for "Tempo node" "cast chain-id --rpc-url $TEMPO_URL"
    if [ -n "$ETH_FORK_RPC" ]; then
        # A fork's clock starts behind real time; the guard compares it with Tempo's
        cast rpc evm_setNextBlockTimestamp "$(date +%s)" --rpc-url "$ETH_URL" >/dev/null
        cast rpc evm_mine --rpc-url "$ETH_URL" >/dev/null
        echo "Ethereum: fork of chain $(cast chain-id --rpc-url "$ETH_FORK_RPC") ($ETH_FORK_RPC) on $ETH_URL"
    else
        # The sdk batches reads through Multicall3, which Sepolia and mainnet
        # have at its canonical address and a fresh chain does not
        (cd "$REPO/ethereum" && ETH_NETWORK=hardhat npx hardhat compile --quiet >/dev/null 2>&1)
        cast rpc hardhat_setCode 0xcA11bde05977b3631167028862bE2a173976CA11 \
            "$(node -p "require('$REPO/ethereum/artifacts/contracts/test/Multicall3.sol/Multicall3.json').deployedBytecode")" \
            --rpc-url "$ETH_URL" >/dev/null
        echo "Ethereum: a fresh local chain on $ETH_URL (offline), with Multicall3 at its canonical address"
    fi
    echo "Tempo: anvil --network tempo on $TEMPO_URL, state from ${TEMPO_FORK_RPC:-nowhere (offline)}"

    say "Building the contracts and the client"
    (cd "$REPO" && npm run -s build -w ethereum -w tempo -w client >/dev/null)
}
