#!/usr/bin/env bash
# run-scenario.sh <template-id> [--cp CERTCP1] [--timeout N] [--connector N]
#
# Runs one cert16-* certification scenario end-to-end against a real SteVe
# CSMS: launches the simulator (post-boot stdin method -- connect, wait past
# BootNotification.conf, then the run_scenario_template JSON command, which
# sidesteps the CLI startup-scenario boot-gate race entirely regardless of
# which fixes are on this branch), tees the wire log to
# results/<template-id>.log, drives the scenario's CSMS-side operator
# actions (specs/<template-id>.spec.sh's drive()), and asserts the expected
# outcome (that spec's assert()).
#
# Exits 0 on PASS, 1 on FAIL (or on any setup/timeout error).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

usage() {
  cat <<EOF
Usage: $(basename "$0") <template-id> [--cp CERTCP1] [--timeout N] [--connector N]

  <template-id>   e.g. cert16-tc001-cold-boot (must have specs/<id>.spec.sh)
  --cp CP_ID       charge box to drive the scenario on (default: $DEFAULT_CP_ID)
  --timeout N      override the spec's default post-trigger hold time (seconds)
  --connector N    override the spec's default connector (default: 1)
EOF
}

[ "$#" -ge 1 ] || {
  usage
  exit 1
}

TEMPLATE_ID="$1"
shift
CP_ID="$DEFAULT_CP_ID"
TIMEOUT_OVERRIDE=""
CONNECTOR_OVERRIDE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
  --cp)
    CP_ID="$2"
    shift 2
    ;;
  --timeout)
    TIMEOUT_OVERRIDE="$2"
    shift 2
    ;;
  --connector)
    CONNECTOR_OVERRIDE="$2"
    shift 2
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    die "unknown argument: $1"
    ;;
  esac
done

SPEC_FILE="$SPECS_DIR/$TEMPLATE_ID.spec.sh"
[ -f "$SPEC_FILE" ] || die "no spec file for '$TEMPLATE_ID' (expected $SPEC_FILE)"

require_cmd docker
require_cmd curl

# Defaults a spec may override.
SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=30

# shellcheck source=/dev/null
source "$SPEC_FILE"

[ -n "$CONNECTOR_OVERRIDE" ] && SPEC_CONNECTOR="$CONNECTOR_OVERRIDE"
[ -n "$TIMEOUT_OVERRIDE" ] && SPEC_HOLD_SECS="$TIMEOUT_OVERRIDE"

CHECK_TOTAL=0
CHECK_FAILED=0
LOG_FILE="$RESULTS_DIR/$TEMPLATE_ID.log"
RESULT_FILE="$RESULTS_DIR/$TEMPLATE_ID.result"

log_info "=== $TEMPLATE_ID on $CP_ID (connector $SPEC_CONNECTOR, boot-wait ${SPEC_BOOT_WAIT}s, hold ${SPEC_HOLD_SECS}s) ==="

db_close_stale_tx "$CP_ID"

CONTAINER="$(sim_start "$CP_ID" "$TEMPLATE_ID" "$SPEC_CONNECTOR" "$SPEC_BOOT_WAIT" "$SPEC_HOLD_SECS")"
log_info "simulator container: $CONTAINER"

cleanup() { sim_stop "$CONTAINER"; }
trap cleanup EXIT

if ! sim_wait_log "$CONTAINER" 'Scenario execution started' 20 "scenario start"; then
  log_warn "did not see 'Scenario execution started' within 20s -- continuing anyway, assert() will likely fail if the scenario never ran"
fi

if declare -f drive >/dev/null 2>&1; then
  log_info "running drive() for $TEMPLATE_ID"
  drive
else
  log_info "no drive() defined (CP-only scenario) -- nothing to do while it runs"
fi

TOTAL_LIFETIME=$((SPEC_BOOT_WAIT + SPEC_HOLD_SECS + 15))
sim_wait_stopped "$CONTAINER" "$TOTAL_LIFETIME" || true

sim_log "$CONTAINER" >"$LOG_FILE"
log_info "log captured: $LOG_FILE ($(wc -l <"$LOG_FILE" | tr -d ' ') lines)"

sim_stop "$CONTAINER"
trap - EXIT

log_info "running assert() for $TEMPLATE_ID"
assert "$LOG_FILE"

VERDICT="PASS"
[ "$CHECK_FAILED" -gt 0 ] && VERDICT="FAIL"

{
  echo "template_id=$TEMPLATE_ID"
  echo "cp_id=$CP_ID"
  echo "verdict=$VERDICT"
  echo "checks=$CHECK_TOTAL"
  echo "failed=$CHECK_FAILED"
  echo "timestamp=$(date -u +%FT%TZ)"
} >"$RESULT_FILE"

log_info "RESULT: $TEMPLATE_ID $VERDICT ($CHECK_TOTAL checks, $CHECK_FAILED failed)"

[ "$VERDICT" = "PASS" ]
