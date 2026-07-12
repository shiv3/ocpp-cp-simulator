#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_055 Trigger Message -- Rejected. Scenario pre-arms a Rejected response
# override; CP answers Rejected and sends nothing.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=12

drive() {
  sleep 2
  steve_op v1.6/TriggerMessage \
    "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
    triggerMessage=Heartbeat connectorId= || true
}

assert() {
  local log="$1"

  check_log_contains "$log" 'Received: \[2,.*"TriggerMessage"' \
    "TriggerMessage.req received"
  check_response_status "$log" "TriggerMessage" "Rejected" \
    "TriggerMessage rejected"
  check_log_not_contains "$log" 'Sent: \[2,.*"Heartbeat"' \
    "no Heartbeat sent (rejected, nothing triggered)"
}
