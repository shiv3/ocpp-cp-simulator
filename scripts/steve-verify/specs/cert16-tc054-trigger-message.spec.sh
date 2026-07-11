#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_054 Trigger Message -- CSMS sends TriggerMessage requesting a message
# type; CP answers Accepted and sends the requested message (Heartbeat here).

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
  check_response_status "$log" "TriggerMessage" "Accepted" \
    "TriggerMessage accepted"
  check_log_order "$log" \
    'Received: \[2,.*"TriggerMessage"' \
    'Sent: \[2,.*"Heartbeat"' \
    "requested Heartbeat sent after TriggerMessage"
}
