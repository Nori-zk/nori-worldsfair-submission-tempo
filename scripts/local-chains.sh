# Local chains for the scripts, sourced by dry-run.sh, migrate-dry-run.sh and
# dev-local.sh: a Hardhat fork of Ethereum on 18545 (a fresh local chain when
# ETH_FORK_RPC is empty) and `anvil --network tempo` on 18546, with the read
# loop's contracts deployed on them.
#
# The sourcing script sets ETH_FORK_RPC, TEMPO_FORK_RPC and KEEP (1 leaves the
# chains running at exit), and may add ports to EXTRA_PORTS for check_local to
# require free. Cleanup stops only the processes the script started (PIDS).
# MIGRATION=1 also deploys DUSD, the ERC-20 the migrate app moves to Tempo,
# and has Nori adopt the issuer's TIP-20 of it (use_bridge_with_adopt first).
#
# Needs: npm install && npm run build (once), anvil and cast (Foundry, with
# `anvil --network tempo`). Uses a temp dir; it ignores your .env.

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
W=$(mktemp -d "${TMPDIR:-/tmp}/nori-local.XXXXXX")  # GNU and BSD mktemp
ETH_URL=http://127.0.0.1:18545
TEMPO_URL=http://127.0.0.1:18546
# Hardhat's and anvil's public test key 0
DEV_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
# Test keys 1 and 2: the issuer of the migrated ERC-20, and a holder
ISSUER_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
HOLDER_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
# Local Ethereum's chain id: not local Tempo's 31337, so one wallet can tell
# the two chains apart (the migrate app signs on both)
ETH_LOCAL_CHAIN_ID=1337
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
# Stops a started process and everything under it (npx runs the Hardhat node,
# npm the dev servers, levels below the pid), resuming each first in case
# outage.sh froze it. Never by port: that would stop whatever else holds it.
kill_tree() { local child; for child in $(pgrep -P "$1"); do kill_tree "$child"; done; kill -CONT "$1" 2>/dev/null || true; kill "$1" 2>/dev/null || true; }
cleanup() {
    if [ "$KEEP" = 1 ]; then
        echo; echo "Chains left running (pids ${PIDS[*]:-}); work dir $W"
        return
    fi
    for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill_tree "$pid"; done
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

# Multicall3's canonical address, where the sdk batches a queue's first reads
MULTICALL3_ADDRESS=0xcA11bde05977b3631167028862bE2a173976CA11

# Starts both chains and sets ETH_START_BLOCK, the fork's block before any deploy.
start_chains() {
    say "Starting chains (logs in $W)"
    if [ -n "$ETH_FORK_RPC" ]; then ETH_SOURCE=(--fork "$ETH_FORK_RPC"); else ETH_SOURCE=(); fi
    (cd "$REPO/ethereum" && ETH_NETWORK=hardhat exec npx hardhat node "${ETH_SOURCE[@]}" --chain-id "$ETH_LOCAL_CHAIN_ID" --port 18545) >"$W/ethereum.log" 2>&1 &
    PIDS+=($!)
    # A fork keeps the local chain id, which deployNoriBridge requires
    if [ -n "$TEMPO_FORK_RPC" ]; then TEMPO_SOURCE=(--fork-url "$TEMPO_FORK_RPC" --chain-id 31337); else TEMPO_SOURCE=(); fi
    anvil --network tempo --port 18546 "${TEMPO_SOURCE[@]}" >"$W/tempo.log" 2>&1 &
    PIDS+=($!)
    wait_for "Ethereum fork" "cast chain-id --rpc-url $ETH_URL"
    wait_for "Tempo node" "cast chain-id --rpc-url $TEMPO_URL"
    # A fork's clock starts behind real time; the guard compares it with Tempo's.
    # Strictly after the latest block: a fresh chain's genesis can hold this second.
    local now latest
    now=$(date +%s)
    latest=$(cast block latest --field timestamp --rpc-url "$ETH_URL")
    cast rpc evm_setNextBlockTimestamp "$((now > latest ? now : latest + 1))" --rpc-url "$ETH_URL" >/dev/null
    cast rpc evm_mine --rpc-url "$ETH_URL" >/dev/null
    if [ -z "$ETH_FORK_RPC" ]; then
        # A fresh chain has no Multicall3: plant the vendored one (ethereum/contracts/test)
        cast rpc hardhat_setCode "$MULTICALL3_ADDRESS" \
            "$(node -p "require('$REPO/ethereum/artifacts/contracts/test/Multicall3.sol/Multicall3.json').deployedBytecode")" \
            --rpc-url "$ETH_URL" >/dev/null
    fi
    ETH_START_BLOCK=$(cast block-number --rpc-url "$ETH_URL")
    if [ -n "$ETH_FORK_RPC" ]; then
        echo "Ethereum: fork of chain $(cast chain-id --rpc-url "$ETH_FORK_RPC") ($ETH_FORK_RPC) on $ETH_URL"
    else
        echo "Ethereum: a fresh local chain (offline), Multicall3 planted, on $ETH_URL"
    fi
    echo "Tempo: anvil --network tempo on $TEMPO_URL, state from ${TEMPO_FORK_RPC:-nowhere (offline)}"
}

# The Nori bridge with adoptMirror (@nori-zk/tempo-token-bridge 0.0.3): the
# installed package once it has it, otherwise the artifact committed in a
# nori-tempo-sdk checkout next to this repo (or at NORI_TEMPO_SDK), which
# deployNoriBridge deploys instead (NORI_TEMPO_BRIDGE_ARTIFACT).
use_bridge_with_adopt() {
    if (cd "$REPO/tempo" && node -e "import('@nori-zk/tempo-token-bridge').then((m) => process.exit(m.NoriTempoTokenBridge__factory.createInterface().getFunction('adoptMirror') ? 0 : 1))" 2>/dev/null); then
        return
    fi
    local sdk=${NORI_TEMPO_SDK:-$REPO/../nori-tempo-sdk}
    export NORI_TEMPO_BRIDGE_ARTIFACT=$sdk/tempo/artifacts/contracts/NoriTempoTokenBridge.sol/NoriTempoTokenBridge.json
    if ! grep -q adoptMirror "$NORI_TEMPO_BRIDGE_ARTIFACT" 2>/dev/null; then
        echo "The installed @nori-zk/tempo-token-bridge has no adoptMirror (0.0.3), and $NORI_TEMPO_BRIDGE_ARTIFACT"
        echo "is missing or older. Check out nori-tempo-sdk's issuer-owned mirrors there, or set NORI_TEMPO_SDK."
        exit 1
    fi
}

# Deploys DUSD on Ethereum as the issuer, minting 1,000,000 to $1, and
# exports NORI_ETH_ISSUER_TOKEN_ADDRESS.
deploy_issuer_token() {
    (cd "$REPO/ethereum" && ETH_PRIVATE_KEY=$ISSUER_KEY quiet npx hardhat --network localfork deployIssuerToken 1000000 --holder "$1" | grep -oE "DemoIssuerToken DUSD deployed to 0x[0-9a-fA-F]+")
    set -a
    . "$W/.env.nori-eth-migration"
    set +a
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

    local adopt=()
    if [ "${MIGRATION:-0}" = 1 ]; then
        say "Ethereum: the issuer deploys DUSD and mints 1,000,000 to test key 2, for your wallet"
        deploy_issuer_token "$(cast wallet address "$HOLDER_KEY")"
        adopt=(--adopt "$NORI_ETH_ISSUER_TOKEN_ADDRESS")
    fi

    local adopted=''
    [ "${#adopt[@]}" -gt 0 ] && adopted=", DUSD's TIP-20 (created by its issuer, adopted by Nori)"
    say "Tempo: deploying the Nori bridge proving that queue, with a mirror of the lockbox$adopted, Backstop and a demo token with supply 116,700"
    (cd "$REPO/tempo" && quiet npx hardhat --network localnet deployNoriBridge "$NORI_ETH_PROOF_QUEUE_ADDRESS" "$NORI_ETH_TOKEN_BRIDGE_ADDRESS" --mirror "$NORI_ETH_DEMO_LOCKBOX_ADDRESS" "${adopt[@]}" | grep -oE "(NoriTempoTokenBridge 0x[0-9a-fA-F]+|Mirror of .*)")
    (cd "$REPO/tempo" && quiet npx hardhat --network localnet deploy | grep -oE "Backstop deployed to: 0x[0-9a-fA-F]+")
    (cd "$REPO/tempo" && quiet npx hardhat --network localnet deployDemo 116700 | grep -oE "Demo token 0x[0-9a-fA-F]+")
    set -a
    . "$W/.env.nori-tempo-bridge"
    . "$W/.env.nori-tempo-backstop"
    . "$W/.env.nori-tempo-demo"
    set +a
}

# Writes $W/keeper.json: the demo guard over the lockbox, and its mirror (and DUSD's, with MIGRATION=1).
write_keeper_config() {
    local mirrors="{ \"name\": \"lockbox-mirror\", \"ethToken\": \"$NORI_ETH_DEMO_LOCKBOX_ADDRESS\" }"
    if [ -n "${NORI_ETH_ISSUER_TOKEN_ADDRESS:-}" ]; then
        mirrors+=", { \"name\": \"dusd\", \"ethToken\": \"$NORI_ETH_ISSUER_TOKEN_ADDRESS\" }"
    fi
    # Offline (no fork), the sdk probes the local nodes for connectivity, not public endpoints
    local network=''
    if [ -z "$ETH_FORK_RPC" ]; then network=", \"network\": { \"probeUrls\": [\"$ETH_URL\", \"$TEMPO_URL\"] }"; fi
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
  "mirrors": [$mirrors]$network
}
EOF
    echo "Keeper config: $W/keeper.json"
}

keeper() { (cd "$REPO/keeper" && quiet npm run -s keeper -- "$1" "$W/keeper.json"); }
prove() { (cd "$REPO/keeper" && quiet npm run -s fake-prover -- "$W/keeper.json"); }
demo_set() { (cd "$REPO/ethereum" && quiet npx hardhat --network localfork demoSet "$@" | grep -oE "DemoLockbox: .*\)"); }
