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
  # check_log_after (not check_log_order): a periodic Heartbeat unrelated to
  # this TriggerMessage could land anywhere in the log and either mask a
  # real failure (an earlier Heartbeat trivially satisfies first-match
  # order) or, on a slow run, not exist yet at check_log_order's checked
  # position. Confirm a Heartbeat appears strictly after the (last)
  # TriggerMessage.req line instead.
  check_log_after "$log" \
    'Received: \[2,.*"TriggerMessage"' \
    'Sent: \[2,.*"Heartbeat"' \
    "requested Heartbeat sent after TriggerMessage"
}
