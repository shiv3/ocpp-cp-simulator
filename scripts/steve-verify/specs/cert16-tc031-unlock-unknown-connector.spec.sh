#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_031 Unlock Connector -- Unknown Connector -- CSMS sends UnlockConnector
# for a non-existent connector id; CP responds NotSupported.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=10

drive() {
  sleep 2
  steve_op v1.6/UnlockConnector "chargePointSelectList=$(steve_cp_select "$CP_ID")" connectorId=99 || true
}

assert() {
  local log="$1"

  check_log_contains "$log" 'Received: \[2,.*"UnlockConnector".*"connectorId":99' \
    "UnlockConnector(connectorId=99).req received"
  check_response_status "$log" "UnlockConnector" "NotSupported" \
    "UnlockConnector -> NotSupported"
}
