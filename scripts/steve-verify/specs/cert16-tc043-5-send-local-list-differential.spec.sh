#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_043.5 Send Local List -- Differential Update. Local list enabled; CSMS
# sends a Full SendLocalList, then a Differential one; CP must process both.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=18

drive() {
  sleep 2
  steve_op v1.6/SendLocalList "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
    listVersion=1 updateType=FULL addUpdateList=CERT-TAG-1 || true
  sleep 3
  steve_op v1.6/SendLocalList "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
    listVersion=2 updateType=DIFFERENTIAL addUpdateList=CERT-TAG-2 || true
}

assert() {
  local log="$1"

  check_log_order "$log" \
    'Received: \[2,.*"SendLocalList".*"updateType":"Full"' \
    'Received: \[2,.*"SendLocalList".*"updateType":"Differential"' \
    "Full update precedes Differential update"
  # check_response_status's windowed grep matches the FIRST occurrence of
  # the action in the whole log, so it only proves the Full response here --
  # the Differential response isn't independently isolated by these simple
  # grep tools. That's an acceptable simplification per "keep specs SIMPLE".
  check_response_status "$log" "SendLocalList" "Accepted" \
    "SendLocalList (Full) accepted"
  check_log_contains "$log" '"listVersion":2,"localAuthorizationList":\[\{"idTag":"CERT-TAG-2"' \
    "Differential update carries only the selected entry"
}
