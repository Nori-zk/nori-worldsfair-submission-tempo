#!/usr/bin/env bash
# The migration demo on Sepolia + Tempo Moderato, on a Nori bridge that is
# already deployed (nori-tempo-sdk's DEPLOYMENT.md): the issuer's ERC-20 on
# Sepolia, its own TIP-20 on Moderato, adopted as the ERC-20's mirror.
#
#   1. Sepolia: the issuer deploys a DemoIssuerToken (DUSD) and mints
#      1,000,000 to the holder -> ethereum/.env.nori-eth-migration
#   2. Moderato: the issuer creates its TIP-20 through TIP20Factory (admin:
#      the issuer) and grants the Nori bridge ISSUER_ROLE, PAUSE_ROLE and
#      UNPAUSE_ROLE; the bridge's deployer adopts it
#      -> tempo/.env.nori-tempo-migration
#
# Safe to rerun: each step is skipped once done.
#
# Usage: scripts/deploy-migration.sh [--holder ADDRESS]
#   --holder ADDRESS  who gets the DUSD supply (default: the issuer)
# Reads from the shell or .env: ETH_NETWORK, ETH_RPC_URL, ETH_PRIVATE_KEY (the
# issuer on Sepolia), NORI_ETH_TOKEN_BRIDGE_ADDRESS; TEMPO_RPC_NETWORK_URL,
# TEMPO_PRIVATE_KEY (the Nori bridge's deployer, which adopts),
# ISSUER_TEMPO_PRIVATE_KEY (the issuer on Moderato; default TEMPO_PRIVATE_KEY),
# NORI_TEMPO_TOKEN_BRIDGE_ADDRESS. Both Tempo keys pay fees in pathUSD.
# Refuses Ethereum mainnet, and any Tempo chain but Moderato or a local node.

set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
SDK_TEMPO=$REPO/../nori-tempo-sdk/tempo
SUPPLY=1000000
HOLDER=
while [ $# -gt 0 ]; do
    case "$1" in
        --holder) HOLDER=${2:?--holder needs an address}; shift ;;
        *) echo "Usage: $0 [--holder ADDRESS]"; exit 1 ;;
    esac
    shift
done
command -v cast >/dev/null || { echo "Missing: cast (Foundry)"; exit 1; }
[ -d "$SDK_TEMPO" ] || { echo "Missing the sdk checkout at $SDK_TEMPO"; exit 1; }

# The shell wins; otherwise the last line in .env that sets it
from_env_file() {
    [ -f "$REPO/.env" ] || return 0
    grep -E "^$1=" "$REPO/.env" | tail -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
}
setting() { local value=${!1:-}; [ -n "$value" ] && echo "$value" || from_env_file "$1"; }
required() { local value; value=$(setting "$1"); [ -n "$value" ] || { echo "Set $1 (.env)"; exit 1; }; echo "$value"; }

ETH_URL=$(required ETH_RPC_URL)
ETH_TOKEN_BRIDGE=$(required NORI_ETH_TOKEN_BRIDGE_ADDRESS)
TEMPO_URL=$(required TEMPO_RPC_NETWORK_URL)
NORI_KEY=$(required TEMPO_PRIVATE_KEY)
ISSUER_TEMPO_KEY=$(setting ISSUER_TEMPO_PRIVATE_KEY)
ISSUER_TEMPO_KEY=${ISSUER_TEMPO_KEY:-$NORI_KEY}
TEMPO_BRIDGE=$(required NORI_TEMPO_TOKEN_BRIDGE_ADDRESS)

# A constant of @nori-zk/tempo-token-bridge
tempo_const() {
    (cd "$REPO/tempo" && node --input-type=module -e \
        "const m = await import('@nori-zk/tempo-token-bridge'); console.log(String(m.$1))")
}
TEMPO_CHAIN_ID=$(cast chain-id --rpc-url "$TEMPO_URL")
case "$TEMPO_CHAIN_ID" in
    "$(tempo_const TEMPO_MODERATO_CHAIN_ID)" | "$(tempo_const TEMPO_LOCALNET_CHAIN_ID)") ;;
    *) echo "TEMPO_RPC_NETWORK_URL is chain $TEMPO_CHAIN_ID, not Moderato or a local node; refusing"; exit 1 ;;
esac
[ "$(cast code "$ETH_TOKEN_BRIDGE" --rpc-url "$ETH_URL")" != "0x" ] || { echo "No NoriTokenBridge at $ETH_TOKEN_BRIDGE"; exit 1; }
[ "$(cast code "$TEMPO_BRIDGE" --rpc-url "$TEMPO_URL")" != "0x" ] || { echo "No NoriTempoTokenBridge at $TEMPO_BRIDGE"; exit 1; }

ETH_DIR=${NORI_ETH_ENV_DIR:-$REPO/ethereum}
TEMPO_DIR=${NORI_TEMPO_ENV_DIR:-$REPO/tempo}
ETH_OUT=$ETH_DIR/.env.nori-eth-migration
TEMPO_OUT=$TEMPO_DIR/.env.nori-tempo-migration
value_in() { [ -f "$1" ] && grep -E "^$2=" "$1" | tail -1 | cut -d= -f2- || true; }

# 1. Sepolia: the issuer's ERC-20
TOKEN=$(value_in "$ETH_OUT" NORI_ETH_ISSUER_TOKEN_ADDRESS)
if [ -n "$TOKEN" ] && [ "$(cast code "$TOKEN" --rpc-url "$ETH_URL")" != "0x" ]; then
    echo "DemoIssuerToken $TOKEN exists ($ETH_OUT)"
else
    echo "Deploying the issuer's DemoIssuerToken (DUSD), $SUPPLY to ${HOLDER:-the issuer}"
    (cd "$REPO" && npm run -s build -w ethereum >/dev/null)
    (cd "$REPO" && npm run -s deploy-issuer-token -w ethereum -- "$SUPPLY" ${HOLDER:+--holder "$HOLDER"})
    TOKEN=$(value_in "$ETH_OUT" NORI_ETH_ISSUER_TOKEN_ADDRESS)
fi

# 2. Moderato: the issuer's own TIP-20, adopted as its mirror
MIRROR=$(cast call "$TEMPO_BRIDGE" "mirrorOf(address)(address)" "$TOKEN" --rpc-url "$TEMPO_URL")
if [ "$MIRROR" != "0x0000000000000000000000000000000000000000" ]; then
    echo "Mirror of $TOKEN exists: $MIRROR"
else
    sdk_tempo() {
        local key=$1
        shift
        (cd "$SDK_TEMPO" && TEMPO_NETWORK=moderato TEMPO_RPC_NETWORK_URL=$TEMPO_URL TEMPO_PRIVATE_KEY=$key \
            NORI_TEMPO_TOKEN_BRIDGE_ADDRESS=$TEMPO_BRIDGE npx hardhat --network moderato "$@")
    }
    TIP20=$(value_in "$TEMPO_OUT" NORI_TEMPO_ISSUER_TIP20_ADDRESS)
    if [ -z "$TIP20" ]; then
        echo "The issuer creates its TIP-20 and grants the Nori bridge its roles"
        TIP20=$(sdk_tempo "$ISSUER_TEMPO_KEY" createIssuerTip20 "Demo USD" DUSD USD 2>&1 | tee /dev/stderr |
            grep -oE "created at 0x[0-9a-fA-F]{40}" | awk '{print $3}')
        [ -n "$TIP20" ] || { echo "createIssuerTip20 failed"; exit 1; }
        mkdir -p "$TEMPO_DIR"
        echo "NORI_TEMPO_ISSUER_TIP20_ADDRESS=$TIP20" >>"$TEMPO_OUT"
    fi
    echo "The Nori bridge's deployer adopts $TIP20 as the mirror of $TOKEN"
    sdk_tempo "$NORI_KEY" adoptMirror "$TOKEN" "$TIP20"
    MIRROR=$TIP20
fi
grep -q "^NORI_TEMPO_MIRROR_ADDRESS=$MIRROR$" "$TEMPO_OUT" 2>/dev/null || echo "NORI_TEMPO_MIRROR_ADDRESS=$MIRROR" >>"$TEMPO_OUT"
echo "Done: DUSD $TOKEN on Ethereum, its TIP-20 $MIRROR on Tempo; addresses in $ETH_OUT and $TEMPO_OUT"
echo "Next: npm run migrate -w client -- lock dusd 100   (then claim once Nori proves it; status)"
