#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_019_1 Retrieve All Configuration Keys -- CSMS sends GetConfiguration
# with no key filter; CP returns all supported configuration keys.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=12

drive() {
  sleep 2
  steve_op v1.6/GetConfiguration "chargePointSelectList=$(steve_cp_select "$CP_ID")" || true
}

assert() {
  local log="$1"

  check_log_contains "$log" 'Received: \[2,.*"GetConfiguration".*"key":\[\]' \
    "GetConfiguration(no filter).req received"
  check_log_contains "$log" 'Sent: \[3,.*"configurationKey":\[{"key"' \
    "CALLRESULT returns a configurationKey list"
  check_log_contains "$log" '"HeartbeatInterval"' \
    "response includes HeartbeatInterval"
  check_log_contains "$log" '"SupportedFeatureProfiles"' \
    "response includes SupportedFeatureProfiles"
}
