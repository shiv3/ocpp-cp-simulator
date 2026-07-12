#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_042.1 Get Local List Version -- Not Supported. Local list disabled via
# configSet; CSMS sends GetLocalListVersion; CP must answer listVersion -1.

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
  # No "status" field on this CALLRESULT (just {"listVersion":-1}), so
  # check_response_status doesn't apply -- this run has exactly one
  # call/response pair, so a direct grep for the value is simple and honest.
  check_log_contains "$log" '"listVersion":-1' \
    "listVersion -1 returned (local list disabled)"
}
