#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_043.1 Send Local List -- Not Supported. Local list disabled via
# configSet; CSMS sends SendLocalList; CP must answer NotSupported.

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
  check_response_status "$log" "SendLocalList" "NotSupported" \
    "SendLocalList rejected as NotSupported (local list disabled)"
}
