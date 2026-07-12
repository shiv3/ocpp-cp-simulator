#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_019_2 Retrieve Specific Configuration Key -- CSMS sends GetConfiguration
# for a single key (HeartbeatInterval); CP returns just that key.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=12

drive() {
  sleep 2
  steve_op v1.6/GetConfiguration "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
    confKeyList=HeartbeatInterval || true
}

assert() {
  local log="$1"

  check_log_contains "$log" 'Received: \[2,.*"GetConfiguration".*"key":\["HeartbeatInterval"\]' \
    "GetConfiguration(HeartbeatInterval).req received"
  check_log_contains "$log" 'Sent: \[3,.*"configurationKey":\[{"key":"HeartbeatInterval"' \
    "CALLRESULT returns the HeartbeatInterval key"
}
