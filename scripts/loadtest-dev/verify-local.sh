#!/usr/bin/env bash
# Verify run.ts against the local mock CSMS (never the real target).
#
#   bash scripts/loadtest-dev/verify-local.sh [COUNT] [RAMP_SEC] [OUT]
#
# Timeline (seconds from now): fleet creation 0..LEAD, ramp LEAD..LEAD+RAMP,
# steady, mock restart (SIGTERM + 5 s down + start) at RESTART, client storm
# at STORM, end at END. Environment overrides: LEAD, STEADY, DOWN_SEC,
# RESTART_KILL (TERM|KILL), HB (mock heartbeat interval), WINDOW, PER_DAEMON,
# TLS=1 (wss with a self-signed certificate), CPUS_RUN / CPUS_MOCK (taskset
# CPU lists, e.g. CPUS_RUN=0,1 CPUS_MOCK=2,3 to emulate a 2 vCPU VM on a
# bigger host: runner + daemons on 2 cores, the mock elsewhere).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"
COUNT="${1:-4000}"
RAMP="${2:-120}"
OUT="${3:-/tmp/loadtest-verify-$(date +%s)}"
LEAD="${LEAD:-90}"
STEADY="${STEADY:-150}"
DOWN_SEC="${DOWN_SEC:-5}"
RESTART_KILL="${RESTART_KILL:-TERM}"
HB="${HB:-30}"
WINDOW="${WINDOW:-65}"
PER_DAEMON="${PER_DAEMON:-1000}"
PORT=19001
mkdir -p "$OUT"
ulimit -n 65536 2>/dev/null || ulimit -n "$(ulimit -Hn)"

NOW=$(date +%s)
RAMP_START=$((NOW + LEAD))
RESTART_AT=$((RAMP_START + RAMP + STEADY))
STORM_AT=$((RESTART_AT + ${STORM_GAP:-240}))
END=$((STORM_AT + ${TAIL_SEC:-210}))
echo "verify: count=$COUNT ramp=$RAMP_START (+${RAMP}s) restart=$RESTART_AT storm=$STORM_AT end=$END out=$OUT"

SCHEME=ws
TLS_ARGS=()
RUN_TLS=()
if [ "${TLS:-0}" = "1" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$OUT/key.pem" -out "$OUT/cert.pem" -days 2 \
    -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
  SCHEME=wss
  TLS_ARGS=(--tls-cert "$OUT/cert.pem" --tls-key "$OUT/key.pem")
  RUN_TLS=(--tls-ca "$OUT/cert.pem")
fi

PIN_RUN=()
PIN_MOCK=()
[ -n "${CPUS_RUN:-}" ] && PIN_RUN=(taskset -c "$CPUS_RUN")
[ -n "${CPUS_MOCK:-}" ] && PIN_MOCK=(taskset -c "$CPUS_MOCK")

start_mock() {
  "${PIN_MOCK[@]}" bun scripts/loadtest-dev/mockCsms.ts --port "$PORT" --hb-interval "$HB" --stats "$OUT/mock-stats-$1.json" \
    "${TLS_ARGS[@]}" >>"$OUT/mock.log" 2>&1 &
  echo $! >"$OUT/mock.pid"
}
start_mock 1

# The "operator": restart the mock at RESTART_AT.
(
  sleep $((RESTART_AT - $(date +%s)))
  echo "$(date -u +%FT%T.%3NZ) operator: kill -$RESTART_KILL mock" >>"$OUT/operator.log"
  kill -"$RESTART_KILL" "$(cat "$OUT/mock.pid")" || true
  sleep "$DOWN_SEC"
  echo "$(date -u +%FT%T.%3NZ) operator: start mock" >>"$OUT/operator.log"
  start_mock 2
  wait
) &
OPERATOR=$!

set +e
"${PIN_RUN[@]}" bun scripts/loadtest-dev/run.ts --url "$SCHEME://localhost:$PORT/chargepoint/" --count "$COUNT" \
  --per-daemon "$PER_DAEMON" --ramp-start "$RAMP_START" --ramp-sec "$RAMP" --observe-until "$END" \
  --client-storm-at "$STORM_AT" --hb-window "$WINDOW" --out "$OUT" "${RUN_TLS[@]}"
RC=$?
set -e
kill -TERM "$(cat "$OUT/mock.pid")" 2>/dev/null || true
kill "$OPERATOR" 2>/dev/null || true
sleep 1
echo "runner exit=$RC; leftover simulator processes for this run: $(pgrep -fc "$OUT/trace-d" || true)"
exit $RC
