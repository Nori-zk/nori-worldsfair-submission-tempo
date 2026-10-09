#!/usr/bin/env bash
# Tempo side of the demo: deploys Backstop (again only when the deployed code
# differs from the build) and, once, creates a demo TIP-20 with supply 116,700
# held by the deployer. Writes the addresses to tempo/.env.nori-tempo-backstop
# and tempo/.env.nori-tempo-demo, which the keeper reads.
#
# Usage: scripts/deploy-moderato.sh
#        TOKEN_VAR=BACKSTOP_SHADOW_TOKEN scripts/deploy-moderato.sh   # a second token
#        (TOKEN_VAR names the variable; default BACKSTOP_DEMO_TOKEN)
# Reads TEMPO_NETWORK, TEMPO_RPC_NETWORK_URL and TEMPO_PRIVATE_KEY from the
# shell or .env. The deployer pays the fees in its fee token and becomes the
# demo token's admin and issuer. Refuses any chain but Moderato or a local
# node. NORI_TEMPO_ENV_DIR redirects the output files.

set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
SUPPLY=116700
TOKEN_VAR=${TOKEN_VAR:-BACKSTOP_DEMO_TOKEN}
[[ "$TOKEN_VAR" =~ ^[A-Z_][A-Z0-9_]*$ ]] || { echo "Invalid TOKEN_VAR: $TOKEN_VAR"; exit 1; }
command -v cast >/dev/null || { echo "Missing: cast (Foundry)"; exit 1; }

# The shell wins; otherwise the last line in .env that sets it
from_env_file() {
    [ -f "$REPO/.env" ] || return 0
    grep -E "^$1=" "$REPO/.env" | tail -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
}
URL=${TEMPO_RPC_NETWORK_URL:-$(from_env_file TEMPO_RPC_NETWORK_URL)}
[ -n "$URL" ] || { echo "Set TEMPO_RPC_NETWORK_URL (.env)"; exit 1; }

# A constant of @nori-zk/tempo-token-bridge
tempo_const() {
    (cd "$REPO/tempo" && node --input-type=module -e \
        "const m = await import('@nori-zk/tempo-token-bridge'); console.log(String(m.$1))")
}
CHAIN_ID=$(cast chain-id --rpc-url "$URL")
case "$CHAIN_ID" in
    "$(tempo_const TEMPO_MODERATO_CHAIN_ID)" | "$(tempo_const TEMPO_LOCALNET_CHAIN_ID)") ;;
    *) echo "TEMPO_RPC_NETWORK_URL is chain $CHAIN_ID, not Moderato or a local node; refusing"; exit 1 ;;
esac

DIR=${NORI_TEMPO_ENV_DIR:-$REPO/tempo}
BACKSTOP_OUT=$DIR/.env.nori-tempo-backstop
DEMO_OUT=$DIR/.env.nori-tempo-demo
value_in() { [ -f "$1" ] && grep -E "^$2=" "$1" | tail -1 | cut -d= -f2- || true; }

echo "Building Backstop"
(cd "$REPO" && npm run -s build -w tempo >/dev/null)

BACKSTOP=$(value_in "$BACKSTOP_OUT" NORI_TEMPO_BACKSTOP_ADDRESS)
BUILT=$(cd "$REPO/tempo" && node --input-type=module -e \
    "const m = await import('@nori-zk/tempo-backstop'); console.log(m.backstopJson.deployedBytecode)")
if [ -n "$BACKSTOP" ] && [ "$(cast code "$BACKSTOP" --rpc-url "$URL")" = "$BUILT" ]; then
    echo "Backstop $BACKSTOP is up to date"
else
    # A contract is not upgraded in place: a new Backstop starts with no guards
    [ -z "$BACKSTOP" ] || echo "Backstop $BACKSTOP differs from the build; deploying a new one (create the guards on it)"
    (cd "$REPO" && npm run -s deploy -w tempo)
fi

TOKEN=$(value_in "$DEMO_OUT" "$TOKEN_VAR")
if [ -n "$TOKEN" ]; then
    echo "$TOKEN_VAR $TOKEN exists ($DEMO_OUT); supply $(cast call "$TOKEN" 'totalSupply()(uint256)' --rpc-url "$URL")"
    exit 0
fi

echo "Creating a demo token for $TOKEN_VAR"
(cd "$REPO" && npm run -s deploy-demo -w tempo -- "$SUPPLY" --env-var "$TOKEN_VAR")
