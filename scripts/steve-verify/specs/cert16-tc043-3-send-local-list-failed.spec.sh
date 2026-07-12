#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_043.3 Send Local List -- Failed. Local list enabled; scenario pre-arms a
# Failed responseOverride; CSMS sends SendLocalList; CP must answer Failed.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=12

drive() {
  sleep 2
  steve_op v1.6/SendLocalList "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
    listVersion=1 updateType=FULL addUpdateList=CERT-TAG-1 || true
}

assert() {
  local log="$1"

  check_log_contains "$log" 'Received: \[2,.*"SendLocalList"' \
    "SendLocalList.req received"
  check_response_status "$log" "SendLocalList" "Failed" \
    "SendLocalList rejected as Failed (pre-armed override)"
}
