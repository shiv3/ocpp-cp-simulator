#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_021 Change Configuration -- CSMS sends ChangeConfiguration to update
# MeterValueSampleInterval; CP accepts and applies the change.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=12

drive() {
  sleep 2
  steve_op v1.6/ChangeConfiguration "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
    keyType=PREDEFINED confKey=MeterValueSampleInterval customConfKey= value=10 || true
}

assert() {
  local log="$1"

  check_log_contains "$log" 'Received: \[2,.*"ChangeConfiguration".*"key":"MeterValueSampleInterval".*"value":"10"' \
    "ChangeConfiguration(MeterValueSampleInterval=10).req received"
  check_response_status "$log" "ChangeConfiguration" "Accepted" \
    "ChangeConfiguration accepted"
}
