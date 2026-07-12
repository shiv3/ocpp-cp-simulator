#!/usr/bin/env bash
# lib.sh -- shared helpers for the SteVe certification-scenario verification
# suite's bash ENVIRONMENT layer (01-setup-steve.sh / 02-provision.sh /
# 99-teardown.sh). Sourced by those three scripts; never run directly.
#
# The bash RUNNER layer (run-scenario.sh, run-all.sh, specs/*.spec.sh, and
# this file's sim_*/check_* helpers) was retired in favor of the TypeScript
# runner under runner/ (bun scripts/steve-verify/runner/main.ts) -- see
# README.md. This file now provides only what 01/02/99 need:
#   - env-overridable configuration (STEVE_* vars)
#   - db()/db_scalar() SQL exec against SteVe's MariaDB container
#   - steve_login()/steve_ensure_login() CSMS manager-UI auth (02-provision.sh
#     uses these directly to create charging-profile entities)
#   - wait_for_http()/wait_for_condition() bounded polling helpers
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
# shellcheck disable=SC2034 # consumed by 01-setup-steve.sh's log line and
# 02-provision.sh's SCENARIOS_DIR -- shellcheck can't see either usage when
# lib.sh is linted as a standalone target rather than via -x on its callers.
REPO_ROOT="$(cd "$STEVE_VERIFY_DIR/../.." && pwd)"

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

# SteVe manager web UI, driven by steve_login()/steve_ensure_login() below
# (02-provision.sh's ensure_charging_profile() uses these directly).
STEVE_URL="${STEVE_URL:-http://localhost:${STEVE_APP_HOST_PORT}/steve/manager}"
STEVE_USER="${STEVE_USER:-admin}"
STEVE_PASS="${STEVE_PASS:-1234}"
# Per-process by default ($$) so concurrent invocations never race on the
# same cookie jar/CSRF state -- each process gets its own file. Override
# explicitly if a caller genuinely wants a shared jar (e.g. re-using a login
# across manual invocations in the same shell).
STEVE_JAR="${STEVE_JAR:-/tmp/steve-verify-cookies.$$.jar}"

# docker compose project network (default matches a plain `docker compose up
# -d` from STEVE_REPO_DIR; the TypeScript runner joins the same network to
# reach the app container as "app:8180" -- see README.md "How it works").
STEVE_NETWORK="${STEVE_NETWORK:-steve_default}"
STEVE_DB_CONTAINER="${STEVE_DB_CONTAINER:-steve-db-1}"

# DB credentials, from SteVe's src/main/resources/application-docker.properties.
STEVE_DB_USER="${STEVE_DB_USER:-steve}"
STEVE_DB_PASS="${STEVE_DB_PASS:-changeme}"
STEVE_DB_NAME="${STEVE_DB_NAME:-stevedb}"

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

# db_latest_open_tx_pk CP_ID -- most recent transaction_pk still open
# (stop_timestamp IS NULL) for a charge box. Empty if none.
db_latest_open_tx_pk() {
  db_scalar "SELECT t.transaction_pk FROM transaction t JOIN evse e ON e.evse_pk = t.evse_pk WHERE e.charge_box_id = '$1' AND t.stop_timestamp IS NULL ORDER BY t.transaction_pk DESC LIMIT 1;"
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
# SteVe manager UI: login (folded in from .steve-op.sh; the CSMS-operation
# POST half, steve_op(), moved to the TypeScript runner's steve.ts)
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
