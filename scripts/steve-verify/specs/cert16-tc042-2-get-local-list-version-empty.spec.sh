#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_042.2 Get Local List Version -- Empty. Local list enabled via configSet
# on a fresh CP; CSMS sends GetLocalListVersion; CP must answer listVersion 0.
#
# NOTE: version 0 holds regardless of run order -- lib.sh's sim_start()
# launches a FRESH simulator container per scenario, and
# LocalAuthListManager's list/version live only in that process's memory
# (see src/cp/domain/auth/LocalAuthList.ts), so a prior SendLocalList run
# against the same $CP_ID (even earlier in the same run-all.sh sweep)
# leaves nothing behind here. Do not "fix" this by resetting/isolating
# state -- there's no cross-run state to reset.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=12

drive() {
  sleep 2
  steve_op v1.6/GetLocalListVersion "chargePointSelectList=$(steve_cp_select "$CP_ID")" || true
}

assert() {
  local log="$1"

  check_log_contains "$log" 'Received: \[2,.*"GetLocalListVersion"' \
    "GetLocalListVersion.req received"
  check_log_contains "$log" '"listVersion":0' \
    "listVersion 0 returned (local list enabled, empty)"
}
