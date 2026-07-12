#!/usr/bin/env bash
# run-all.sh [--group core|authlist-reservation|remotetrigger-smartcharging|firmware|all] [--parallel]
#
# Sweeps a group of cert16-* scenarios through run-scenario.sh, assigning
# each scenario to one of CERTCP1/2/3 (round-robin, so adjacent scenarios
# don't collide on the same charge point's transaction state), and writes a
# markdown results table to results/summary.md.
#
# Sequential by default (one scenario at a time, regardless of CP
# assignment). --parallel runs up to 3 scenarios concurrently, one per CP.
#
# Exits non-zero if any scenario FAILs (or errors).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

GROUP="all"
PARALLEL=0

while [ "$#" -gt 0 ]; do
  case "$1" in
  --group)
    GROUP="$2"
    shift 2
    ;;
  --parallel)
    PARALLEL=1
    shift
    ;;
  -h | --help)
    echo "Usage: $(basename "$0") [--group core|authlist-reservation|remotetrigger-smartcharging|firmware|all] [--parallel]"
    exit 0
    ;;
  *)
    die "unknown argument: $1"
    ;;
  esac
done

# Group membership mirrors src/utils/scenarios/README.md's Profile column,
# merged into the four verification groups used during manual sign-off:
#   core                     = Core
#   authlist-reservation     = LocalAuthList + Reservation
#   remotetrigger-smartcharging = RemoteTrigger + SmartCharging
#   firmware                 = Firmware

CORE=(
  cert16-tc001-cold-boot
  cert16-tc003-charging-plugin-first
  cert16-tc004-charging-id-first
  cert16-tc005-ev-side-disconnect
  cert16-tc013-hard-reset
  cert16-tc014-soft-reset
  cert16-tc017-unlock-occupied
  cert16-tc018-unlock-failure
  cert16-tc019-get-configuration-all
  cert16-tc019-get-configuration-key
  cert16-tc021-change-configuration
  cert16-tc024-lock-failure
  cert16-tc031-unlock-unknown-connector
  cert16-tc061-clear-cache
  cert16-tc064-data-transfer
)

AUTHLIST_RESERVATION=(
  cert16-tc042-1-get-local-list-version-not-supported
  cert16-tc042-2-get-local-list-version-empty
  cert16-tc043-1-send-local-list-not-supported
  cert16-tc043-3-send-local-list-failed
  cert16-tc043-4-send-local-list-full
  cert16-tc043-5-send-local-list-differential
  cert16-reservation-basic
  cert16-tc048-1-reserve-now-faulted
  cert16-tc048-2-reserve-now-occupied
  cert16-tc048-3-reserve-now-unavailable
  cert16-tc048-4-reserve-now-rejected
  cert16-tc051-cancel-reservation
  cert16-tc052-cancel-reservation-rejected
)

REMOTETRIGGER_SMARTCHARGING=(
  cert16-tc010-remote-start
  cert16-tc011-remote-start-stop
  cert16-tc012-remote-stop
  cert16-tc026-remote-start-rejected
  cert16-tc028-remote-stop-rejected
  cert16-tc054-trigger-message
  cert16-tc055-trigger-message-rejected
  cert16-tc056-central-smart-charging-txdefault
  cert16-tc057-central-smart-charging-txprofile
  cert16-tc059-remote-start-with-profile
  cert16-tc066-get-composite-schedule
  cert16-tc067-clear-charging-profile
)

FIRMWARE=(
  cert16-tc044-1-firmware-update
  cert16-tc044-2-firmware-download-failed
  cert16-tc044-3-firmware-install-failed
  cert16-tc045-1-get-diagnostics
)

case "$GROUP" in
core) SCENARIOS=("${CORE[@]}") ;;
authlist-reservation) SCENARIOS=("${AUTHLIST_RESERVATION[@]}") ;;
remotetrigger-smartcharging) SCENARIOS=("${REMOTETRIGGER_SMARTCHARGING[@]}") ;;
firmware) SCENARIOS=("${FIRMWARE[@]}") ;;
all) SCENARIOS=("${CORE[@]}" "${AUTHLIST_RESERVATION[@]}" "${REMOTETRIGGER_SMARTCHARGING[@]}" "${FIRMWARE[@]}") ;;
*) die "unknown --group '$GROUP' (want: core|authlist-reservation|remotetrigger-smartcharging|firmware|all)" ;;
esac

log_info "group '$GROUP': ${#SCENARIOS[@]} scenario(s), parallel=$PARALLEL"

CPS=(CERTCP1 CERTCP2 CERTCP3)
declare -A CP_FOR=()
i=0
for id in "${SCENARIOS[@]}"; do
  CP_FOR["$id"]="${CPS[$((i % 3))]}"
  i=$((i + 1))
done

run_one() {
  local id="$1" cp="${CP_FOR[$1]}"
  if "$SCRIPT_DIR/run-scenario.sh" "$id" --cp "$cp" >"$RESULTS_DIR/$id.stdout.log" 2>&1; then
    return 0
  fi
  return 1
}

OVERALL_FAIL=0

if [ "$PARALLEL" -eq 1 ]; then
  # Up to 3 concurrent, one per CP -- batch scenarios in groups of 3.
  batch=()
  for id in "${SCENARIOS[@]}"; do
    batch+=("$id")
    if [ "${#batch[@]}" -eq 3 ]; then
      pids=()
      for bid in "${batch[@]}"; do
        run_one "$bid" &
        pids+=($!)
      done
      for pid in "${pids[@]}"; do
        wait "$pid" || OVERALL_FAIL=1
      done
      batch=()
    fi
  done
  if [ "${#batch[@]}" -gt 0 ]; then
    pids=()
    for bid in "${batch[@]}"; do
      run_one "$bid" &
      pids+=($!)
    done
    for pid in "${pids[@]}"; do
      wait "$pid" || OVERALL_FAIL=1
    done
  fi
else
  for id in "${SCENARIOS[@]}"; do
    run_one "$id" || OVERALL_FAIL=1
  done
fi

# ---------------------------------------------------------------------------
# Results table
# ---------------------------------------------------------------------------

SUMMARY="$RESULTS_DIR/summary.md"
{
  echo "# SteVe verification results — group: $GROUP"
  echo
  echo "Run at $(date -u +%FT%TZ)."
  echo
  echo "| scenario | cp | verdict | checks | failed |"
  echo "| --- | --- | --- | --- | --- |"
  for id in "${SCENARIOS[@]}"; do
    result_file="$RESULTS_DIR/$id.result"
    if [ -f "$result_file" ]; then
      # shellcheck disable=SC1090
      (
        verdict=""
        checks=""
        failed=""
        source "$result_file"
        echo "| $id | ${CP_FOR[$id]} | $verdict | $checks | $failed |"
      )
    else
      echo "| $id | ${CP_FOR[$id]} | ERROR | - | - |"
    fi
  done
} >"$SUMMARY"

log_info "results table: $SUMMARY"
cat "$SUMMARY" >&2

if [ "$OVERALL_FAIL" -ne 0 ]; then
  log_err "one or more scenarios FAILed or errored -- see $SUMMARY and results/*.log"
  exit 1
fi

log_info "all scenarios in group '$GROUP' PASSed."
