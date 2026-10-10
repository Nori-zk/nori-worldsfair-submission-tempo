#!/usr/bin/env bash
# Freezes or resumes a local chain started by dev-local.sh or dry-run.sh.
# A frozen chain accepts connections and answers nothing, as an unreachable
# node does, and keeps its state for when it resumes.
#
# Usage: scripts/outage.sh eth|tempo down|up

set -euo pipefail

usage() { echo "Usage: $0 eth|tempo down|up"; exit 1; }
[ $# -eq 2 ] || usage
case "$1" in
    eth) PORT=18545 ;;
    tempo) PORT=18546 ;;
    *) usage ;;
esac
case "$2" in
    down) SIGNAL=STOP ;;
    up) SIGNAL=CONT ;;
    *) usage ;;
esac

PID=$(lsof -t -sTCP:LISTEN -i ":$PORT" 2>/dev/null | head -1)
[ -n "$PID" ] || { echo "No chain on port $PORT"; exit 1; }
kill -"$SIGNAL" "$PID"
echo "$1 (port $PORT, pid $PID): $2"
