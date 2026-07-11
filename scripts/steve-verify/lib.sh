#!/usr/bin/env bash
# lib.sh -- shared helpers for the SteVe certification-scenario verification
# suite. Sourced by every other script in this directory; never run directly.
#
# Provides:
#   - env-overridable configuration (STEVE_* / SIM_* vars)
#   - db()/db_scalar() SQL exec against SteVe's MariaDB container
#   - steve_login()/steve_op() CSMS-operation HTTP helpers (folded in from
#     the untracked .steve-op.sh prototype used during manual verification)
#   - sim_start()/sim_wait_log()/sim_stop() simulator-container helpers
#   - wait_for_http()/wait_for_log() bounded polling helpers
#   - check_*() log/DB assertion helpers used by specs/*.spec.sh
#
# All external waits are bounded and fail with a clear message on timeout --
# nothing in here blocks forever.

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

# Resolve the steve-verify directory from this file's own location, not the
# caller's cwd, so every script works regardless of where it's invoked from.
STEVE_VERIFY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$STEVE_VERIFY_DIR/../.." && pwd)"
RESULTS_DIR="${RESULTS_DIR:-$STEVE_VERIFY_DIR/results}"
RUNTIME_DIR="${RUNTIME_DIR:-$STEVE_VERIFY_DIR/.runtime}"
SPECS_DIR="${SPECS_DIR:-$STEVE_VERIFY_DIR/specs}"

mkdir -p "$RESULTS_DIR" "$RUNTIME_DIR"

# ---------------------------------------------------------------------------
# Configuration (env-overridable)
# ---------------------------------------------------------------------------

# Where a local SteVe checkout lives (used by 01-setup-steve.sh / 99-teardown.sh).
STEVE_REPO_DIR="${STEVE_REPO_DIR:-$HOME/git/steve}"
STEVE_REPO_URL="${STEVE_REPO_URL:-https://github.com/steve-community/steve.git}"

# Host-side ports SteVe's docker-compose.yml is remapped to (avoids the
# common local collision on 3306/8180 -- see README.md "Prerequisites").
STEVE_APP_HOST_PORT="${STEVE_APP_HOST_PORT:-18180}"
STEVE_APP_HOST_TLS_PORT="${STEVE_APP_HOST_TLS_PORT:-18443}"
STEVE_DB_HOST_PORT="${STEVE_DB_HOST_PORT:-13306}"

# SteVe manager web UI, driven by steve_op() below.
STEVE_URL="${STEVE_URL:-http://localhost:${STEVE_APP_HOST_PORT}/steve/manager}"
STEVE_USER="${STEVE_USER:-admin}"
STEVE_PASS="${STEVE_PASS:-1234}"
STEVE_JAR="${STEVE_JAR:-/tmp/steve-verify-cookies.jar}"

# docker compose project container names + network (defaults match a plain
# `docker compose up -d` from STEVE_REPO_DIR with the service names in
# SteVe's docker-compose.yml: "db" / "app").
STEVE_NETWORK="${STEVE_NETWORK:-steve_default}"
STEVE_APP_CONTAINER="${STEVE_APP_CONTAINER:-steve-app-1}"
STEVE_DB_CONTAINER="${STEVE_DB_CONTAINER:-steve-db-1}"

# DB credentials, from SteVe's src/main/resources/application-docker.properties.
STEVE_DB_USER="${STEVE_DB_USER:-steve}"
STEVE_DB_PASS="${STEVE_DB_PASS:-changeme}"
STEVE_DB_NAME="${STEVE_DB_NAME:-stevedb}"

# Simulator invocation. The simulator runs *inside* steve_default and always
# talks to the app container's own port 8180 -- not STEVE_APP_HOST_PORT,
# which only matters for host-side access (steve_op, the manager UI). Kept
# as a plain default (not derived from the host port) so a host-port
# override never breaks it.
SIM_IMAGE="${SIM_IMAGE:-oven/bun:1.3-alpine}"
SIM_WS_URL="${SIM_WS_URL:-ws://app:8180/steve/websocket/CentralSystemService/}"

# Charge boxes / tags provisioned by 02-provision.sh; kept here too so
# run-scenario.sh's default --cp matches without re-declaring it.
DEFAULT_CP_ID="${DEFAULT_CP_ID:-CERTCP1}"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

log_info() { printf '[steve-verify] %s\n' "$*" >&2; }
log_warn() { printf '[steve-verify] WARN: %s\n' "$*" >&2; }
log_err() { printf '[steve-verify] ERROR: %s\n' "$*" >&2; }
die() {
  log_err "$*"
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1 (install it and re-run)"
}

# ---------------------------------------------------------------------------
# Bounded waiting helpers -- every external wait in this suite goes through
# one of these so there's exactly one place that can hang forever, and it
# can't (all bounded, all fail loudly).
# ---------------------------------------------------------------------------

# wait_for_http URL EXPECTED_CODE_REGEX TIMEOUT_SECS [DESCRIPTION]
wait_for_http() {
  local url="$1" expected="$2" timeout="$3" desc="${4:-$1}"
  local waited=0
  local code
  while [ "$waited" -lt "$timeout" ]; do
    code="$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || echo "000")"
    if printf '%s' "$code" | grep -qE "$expected"; then
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  die "timed out after ${timeout}s waiting for $desc (last HTTP code: ${code:-none})"
}

# wait_for_docker_log CONTAINER PATTERN TIMEOUT_SECS [DESCRIPTION]
wait_for_docker_log() {
  local container="$1" pattern="$2" timeout="$3"
  local desc="${4:-$pattern}"
  local waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if docker logs "$container" 2>&1 | grep -qE "$pattern"; then
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  log_warn "timed out after ${timeout}s waiting for '$desc' in $container logs"
  return 1
}

# wait_for_condition TIMEOUT_SECS INTERVAL_SECS DESCRIPTION -- CMD...
# Runs CMD... repeatedly until it exits 0, or dies after TIMEOUT_SECS.
wait_for_condition() {
  local timeout="$1" interval="$2" desc="$3"
  shift 3
  [ "$1" = "--" ] && shift
  local waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if "$@"; then
      return 0
    fi
    sleep "$interval"
    waited=$((waited + interval))
  done
  die "timed out after ${timeout}s waiting for: $desc"
}

# ---------------------------------------------------------------------------
# DB access (docker exec into the SteVe MariaDB container)
# ---------------------------------------------------------------------------

# db SQL -- runs SQL, prints a formatted table (with headers) to stdout.
db() {
  docker exec -i "$STEVE_DB_CONTAINER" \
    mariadb -u"$STEVE_DB_USER" -p"$STEVE_DB_PASS" "$STEVE_DB_NAME" -e "$1"
}

# db_scalar SQL -- runs SQL, prints just the first column of the first row
# (no headers), for use in $(...) capture. Empty string if no rows.
db_scalar() {
  docker exec -i "$STEVE_DB_CONTAINER" \
    mariadb -N -B -u"$STEVE_DB_USER" -p"$STEVE_DB_PASS" "$STEVE_DB_NAME" -e "$1" 2>/dev/null | head -n1
}

# db_latest_tx_pk CP_ID -- most recent transaction_pk for a charge box
# (open or closed).
db_latest_tx_pk() {
  db_scalar "SELECT t.transaction_pk FROM transaction t JOIN evse e ON e.evse_pk = t.evse_pk WHERE e.charge_box_id = '$1' ORDER BY t.transaction_pk DESC LIMIT 1;"
}

# db_latest_open_tx_pk CP_ID -- most recent transaction_pk still open
# (stop_timestamp IS NULL) for a charge box. Empty if none.
db_latest_open_tx_pk() {
  db_scalar "SELECT t.transaction_pk FROM transaction t JOIN evse e ON e.evse_pk = t.evse_pk WHERE e.charge_box_id = '$1' AND t.stop_timestamp IS NULL ORDER BY t.transaction_pk DESC LIMIT 1;"
}

# db_tx_stop_reason TX_PK -- stop_reason column for a transaction (may be
# empty/NULL for the OCPP spec-default "Local").
db_tx_stop_reason() {
  db_scalar "SELECT stop_reason FROM transaction WHERE transaction_pk = $1;"
}

# db_latest_reservation_pk CP_ID -- most recent reservation_pk for a charge
# box (any status).
db_latest_reservation_pk() {
  db_scalar "SELECT r.reservation_pk FROM reservation r JOIN evse e ON e.evse_pk = r.evse_pk WHERE e.charge_box_id = '$1' ORDER BY r.reservation_pk DESC LIMIT 1;"
}

# db_close_stale_tx CP_ID -- closes any transaction left open on a charge
# box from a previous interrupted run, so max_active_transaction_count
# doesn't block the next scenario. Idempotent (no-op if nothing open).
# NOTE: `transaction` is a view over transaction_start/transaction_stop, so
# this inserts into transaction_stop rather than UPDATE-ing the view.
db_close_stale_tx() {
  local cp_id="$1" pk
  pk="$(db_latest_open_tx_pk "$cp_id")"
  if [ -n "$pk" ]; then
    log_warn "closing stale open transaction $pk on $cp_id before starting"
    db "INSERT INTO transaction_stop (transaction_pk, event_timestamp, event_actor, stop_timestamp, stop_value, stop_reason) VALUES ($pk, NOW(), 'manual', NOW(), '0', 'Local');" >/dev/null
  fi
}

# ---------------------------------------------------------------------------
# SteVe manager UI: login + operation POST (folded in from .steve-op.sh)
# ---------------------------------------------------------------------------

_steve_extract_csrf() {
  grep -o 'name="_csrf" value="[^"]*"' "$1" | sed 's/.*value="\(.*\)"/\1/'
}

steve_is_logged_in() {
  [ -f "$STEVE_JAR" ] && curl -sS -b "$STEVE_JAR" -m 10 -o /dev/null -w '%{http_code}' \
    "$STEVE_URL/home" 2>/dev/null | grep -q '^200$'
}

steve_login() {
  local signin_html csrf
  signin_html="$(mktemp)"
  rm -f "$STEVE_JAR"
  curl -sS -c "$STEVE_JAR" -m 10 "$STEVE_URL/signin" -o "$signin_html"
  csrf="$(_steve_extract_csrf "$signin_html")"
  rm -f "$signin_html"
  curl -sS -b "$STEVE_JAR" -c "$STEVE_JAR" -m 10 -o /dev/null \
    --data-urlencode "username=$STEVE_USER" \
    --data-urlencode "password=$STEVE_PASS" \
    --data-urlencode "_csrf=$csrf" \
    "$STEVE_URL/signin"
}

steve_ensure_login() {
  steve_is_logged_in || steve_login
}

# steve_cp_select CP_ID -- the chargePointSelectList form value SteVe
# expects for an OCPP 1.6J charge point, e.g. "V_16_JSON;CERTCP1;-".
steve_cp_select() {
  printf 'V_16_JSON;%s;-' "$1"
}

# steve_op OP_PATH [field=value ...]
# POSTs one CSMS operation, form-encoded, exactly like the manager UI would.
# e.g. steve_op v1.6/RemoteStartTransaction \
#        "chargePointSelectList=$(steve_cp_select CERTCP1)" connectorId=1 idTag=CERT-TAG-1
# On success (SteVe 302s to /operations/tasks/<id>) prints the task URL to
# stdout and returns 0; on failure (no redirect) logs a warning and returns 1.
steve_op() {
  local op_path="$1"
  shift
  steve_ensure_login

  local op_html csrf headers location
  op_html="$(mktemp)"
  # Intentionally expand op_html now (not at trap-fire time) -- it's a
  # fixed mktemp path for this call, not something that changes later.
  # shellcheck disable=SC2064
  trap "rm -f '$op_html'" RETURN

  curl -sS -b "$STEVE_JAR" -c "$STEVE_JAR" -m 10 "$STEVE_URL/operations/$op_path" -o "$op_html"
  csrf="$(_steve_extract_csrf "$op_html")"
  if [ -z "$csrf" ]; then
    log_err "steve_op: could not find CSRF token on $STEVE_URL/operations/$op_path (login may have failed)"
    return 1
  fi

  local curl_args=(-sS -b "$STEVE_JAR" -c "$STEVE_JAR" -m 10 -D - -o /tmp/steve-verify-op-result.html)
  for f in "$@"; do
    curl_args+=(--data-urlencode "$f")
  done
  curl_args+=(--data-urlencode "_csrf=$csrf")

  log_info "POST $STEVE_URL/operations/$op_path $*"
  headers="$(curl "${curl_args[@]}" "$STEVE_URL/operations/$op_path")"

  location="$(printf '%s' "$headers" | grep -i '^Location:' | tr -d '\r' | sed 's/^[Ll]ocation: *//')"
  if [ -n "$location" ]; then
    log_info "OK: operation queued -> $location"
    printf '%s\n' "$location"
    return 0
  fi
  log_warn "steve_op: no redirect Location header for $op_path; see /tmp/steve-verify-op-result.html"
  return 1
}

# ---------------------------------------------------------------------------
# Simulator container helpers
# ---------------------------------------------------------------------------

# sim_container_name CP_ID TEMPLATE_ID -- deterministic, docker-safe name.
sim_container_name() {
  local cp_id="$1" template_id="$2"
  printf 'sim-%s-%s' "$(printf '%s' "$cp_id" | tr '[:upper:]' '[:lower:]')" "$template_id" | cut -c1-63
}

# sim_start CP_ID TEMPLATE_ID CONNECTOR BOOT_WAIT HOLD_SECS
# Launches a detached simulator container that: connects, waits BOOT_WAIT
# seconds (past BootNotification.conf), runs the given scenario template on
# CONNECTOR via the JSON-mode stdin command, then stays connected for
# HOLD_SECS more seconds before exiting on its own (stdin EOF).
# The feeder script MUST live under the repo (bind-mount from a scratch path
# mounts empty -- see README.md "Known limitations").
# Prints the container name on stdout.
sim_start() {
  local cp_id="$1" template_id="$2" connector="$3" boot_wait="$4" hold_secs="$5"
  local container feeder_abs feeder_rel

  container="$(sim_container_name "$cp_id" "$template_id")"
  docker rm -f "$container" >/dev/null 2>&1 || true

  feeder_abs="$RUNTIME_DIR/feeder-${container}.sh"
  feeder_rel="${feeder_abs#"$REPO_ROOT"/}"

  {
    printf '#!/bin/sh\n'
    printf "echo '%s'\n" '{"command":"connect"}'
    printf 'sleep %s\n' "$boot_wait"
    printf "echo '%s'\n" "$(printf '{"command":"run_scenario_template","params":{"connector":%s,"templateId":"%s"}}' "$connector" "$template_id")"
    printf 'sleep %s\n' "$hold_secs"
  } >"$feeder_abs"

  docker run -d --name "$container" --network "$STEVE_NETWORK" \
    -v "$REPO_ROOT:/app" -w /app "$SIM_IMAGE" sh -c \
    "cat /app/$feeder_rel | sh | bun src/cli/main.ts --ws-url $SIM_WS_URL --cp-id $cp_id --json" \
    >/dev/null

  printf '%s\n' "$container"
}

# sim_wait_log CONTAINER PATTERN TIMEOUT_SECS [DESCRIPTION]
sim_wait_log() { wait_for_docker_log "$@"; }

# sim_log CONTAINER -- prints full container log so far.
sim_log() { docker logs "$1" 2>&1; }

# sim_wait_stopped CONTAINER TIMEOUT_SECS -- waits for the container to exit
# on its own (feeder's stdin EOF closes the process). Does not fail the
# caller if it's still running at the timeout -- callers stop it explicitly.
sim_wait_stopped() {
  local container="$1" timeout="$2" waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || echo false)" = "false" ]; then
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  log_warn "$container still running after ${timeout}s; stopping explicitly"
  return 1
}

# sim_stop CONTAINER -- stop+rm, idempotent, never fails the caller.
sim_stop() {
  docker stop "$1" >/dev/null 2>&1 || true
  docker rm -f "$1" >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# Assertion helpers for specs/*.spec.sh -- track pass/fail counts in globals
# reset by run-scenario.sh before sourcing a spec's assert().
# ---------------------------------------------------------------------------

CHECK_TOTAL=0
CHECK_FAILED=0

_check_pass() {
  CHECK_TOTAL=$((CHECK_TOTAL + 1))
  printf '  PASS: %s\n' "$1"
}

_check_fail() {
  CHECK_TOTAL=$((CHECK_TOTAL + 1))
  CHECK_FAILED=$((CHECK_FAILED + 1))
  printf '  FAIL: %s\n' "$1"
  [ -n "${2:-}" ] && printf '        %s\n' "$2"
}

# check_log_contains LOG_FILE PATTERN DESCRIPTION
check_log_contains() {
  if grep -qE "$2" "$1" 2>/dev/null; then
    _check_pass "$3"
  else
    _check_fail "$3" "pattern not found: $2"
  fi
}

# check_log_not_contains LOG_FILE PATTERN DESCRIPTION
check_log_not_contains() {
  if grep -qE "$2" "$1" 2>/dev/null; then
    _check_fail "$3" "pattern unexpectedly found: $2"
  else
    _check_pass "$3"
  fi
}

# check_log_order LOG_FILE PATTERN_A PATTERN_B DESCRIPTION
# Passes if the first line matching PATTERN_A appears before the first line
# matching PATTERN_B.
check_log_order() {
  local log="$1" pa="$2" pb="$3" desc="$4" line_a line_b
  line_a="$(grep -nE "$pa" "$log" 2>/dev/null | head -n1 | cut -d: -f1)"
  line_b="$(grep -nE "$pb" "$log" 2>/dev/null | head -n1 | cut -d: -f1)"
  if [ -z "$line_a" ] || [ -z "$line_b" ]; then
    _check_fail "$desc" "one or both patterns not found (A='$pa' line=${line_a:-none}, B='$pb' line=${line_b:-none})"
  elif [ "$line_a" -lt "$line_b" ]; then
    _check_pass "$desc"
  else
    _check_fail "$desc" "A (line $line_a) did not precede B (line $line_b)"
  fi
}

# check_log_after LOG_FILE AFTER_PATTERN PATTERN DESCRIPTION
# Passes if PATTERN appears anywhere in the log strictly after the LAST line
# matching AFTER_PATTERN. Use this instead of check_log_order when PATTERN
# could also match an earlier, unrelated occurrence -- e.g. a connector's
# automatic post-boot "Available" StatusNotification, which always precedes
# any scenario-driven state change and would make check_log_order's
# first-match semantics pass trivially/incorrectly.
check_log_after() {
  local log="$1" after="$2" pattern="$3" desc="$4" after_line
  after_line="$(grep -nE "$after" "$log" 2>/dev/null | tail -n1 | cut -d: -f1)"
  if [ -z "$after_line" ]; then
    _check_fail "$desc" "reference pattern not found: $after"
    return
  fi
  if tail -n "+$((after_line + 1))" "$log" | grep -qE "$pattern"; then
    _check_pass "$desc"
  else
    _check_fail "$desc" "pattern not found after line $after_line ($after): $pattern"
  fi
}

# check_response_status LOG_FILE REQUEST_ACTION EXPECTED_STATUS DESCRIPTION
# Looks at the CALLRESULT sent within a few lines after a Received CALL for
# REQUEST_ACTION and checks it carries the expected "status" field. Kept
# windowed/approximate on purpose -- these scenarios run one CSMS op at a
# time, so a strict message-bus parser would be overkill.
check_response_status() {
  local log="$1" action="$2" status="$3" desc="$4" window
  window="$(grep -A20 "Received: .*\"$action\"" "$log" 2>/dev/null | grep -m1 'Sent: \[3,' || true)"
  if [ -z "$window" ]; then
    _check_fail "$desc" "no CALLRESULT found after Received .../$action"
  elif printf '%s' "$window" | grep -q "\"status\":\"$status\""; then
    _check_pass "$desc"
  else
    _check_fail "$desc" "expected status=$status, got: $window"
  fi
}

# check_sent_result LOG_FILE REQUEST_ACTION EXPECTED_PATTERN DESCRIPTION
# Mirror of check_response_status for CP-initiated calls (e.g.
# BootNotification, DataTransfer): looks at the CALLRESULT received within
# a few lines after a Sent CALL for REQUEST_ACTION and checks it matches
# EXPECTED_PATTERN (a grep -E pattern applied to that CALLRESULT line).
check_sent_result() {
  local log="$1" action="$2" pattern="$3" desc="$4" window
  window="$(grep -A20 "Sent: \[2,.*\"$action\"" "$log" 2>/dev/null | grep -m1 'Received: \[3,' || true)"
  if [ -z "$window" ]; then
    _check_fail "$desc" "no CALLRESULT received after Sent .../$action"
  elif printf '%s' "$window" | grep -qE "$pattern"; then
    _check_pass "$desc"
  else
    _check_fail "$desc" "expected match for '$pattern', got: $window"
  fi
}

# check_db_nonempty SQL DESCRIPTION -- passes if SQL returns a non-empty
# scalar. Prints the value in the pass/fail line for debugging.
check_db_nonempty() {
  local val
  val="$(db_scalar "$1")"
  if [ -n "$val" ]; then
    _check_pass "$2 (got '$val')"
  else
    _check_fail "$2" "query returned no rows/empty: $1"
  fi
}

# check_db_eq SQL EXPECTED DESCRIPTION
check_db_eq() {
  local val
  val="$(db_scalar "$1")"
  check_eq "$val" "$2" "$3"
}

# check_eq ACTUAL EXPECTED DESCRIPTION
check_eq() {
  if [ "$1" = "$2" ]; then
    _check_pass "$3"
  else
    _check_fail "$3" "expected '$2', got '$1'"
  fi
}

# check_true DESCRIPTION -- CMD...
# Passes if CMD exits 0.
check_true() {
  local desc="$1"
  shift
  [ "$1" = "--" ] && shift
  if "$@" >/dev/null 2>&1; then
    _check_pass "$desc"
  else
    _check_fail "$desc" "command failed: $*"
  fi
}
