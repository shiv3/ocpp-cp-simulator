#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_043.4 Send Local List -- Full Update. Local list enabled; CSMS sends a
# Full SendLocalList; CP must store it and answer Accepted.
#
# Known SteVe quirk (confirmed live): a Full update sends the CP its *entire*
# known ocpp_tag table regardless of which single tag is passed in
# addUpdateList -- only Differential respects the single selection. Not
# asserting an exact entry count here for that reason.

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

  check_log_contains "$log" 'Received: \[2,.*"SendLocalList".*"updateType":"Full"' \
    "SendLocalList.req received with updateType Full"
  check_response_status "$log" "SendLocalList" "Accepted" \
    "SendLocalList (Full) accepted"
}
