#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_042.2 Get Local List Version -- Empty. Local list enabled via configSet
# on a fresh CP; CSMS sends GetLocalListVersion; CP must answer listVersion 0.
#
# NOTE: assumes no prior SendLocalList ran against this $CP_ID earlier in the
# same session (that would legitimately bump the version past 0) -- a known
# cross-scenario-state limitation of running scenarios back-to-back on a
# shared charge point, not a bug in this spec.

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
