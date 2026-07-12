#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_001 Cold Boot -- CP-only scenario, no CSMS-side operator action.
# The scenario re-affirms StatusNotification(Available) after the automatic
# BootNotification/StatusNotification flow, then idles ~10s.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=20

# No drive(): nothing for the CSMS operator to do.

assert() {
  local log="$1"

  check_log_contains "$log" 'Sent: \[2,"[^"]+","BootNotification"' \
    "BootNotification.req sent"
  check_sent_result "$log" "BootNotification" '"status":"Accepted"' \
    "BootNotification accepted"
  check_log_contains "$log" 'Sent: \[2,.*"StatusNotification".*"connectorId":1.*"status":"Available"' \
    "StatusNotification(Available) sent for connector 1"
  check_log_contains "$log" 'Scenario execution completed' \
    "scenario ran to completion"
  check_log_not_contains "$log" 'blocked by the boot gate' \
    "no messages were dropped by the boot gate"
}
