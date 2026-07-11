#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_048.3 ReserveNow -- Unavailable. Connector forced Unavailable; scenario
# pre-arms an Unavailable responseOverride; CSMS sends ReserveNow; CP must
# answer Unavailable, then reset to Available.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=12

drive() {
  sleep 2
  steve_op v1.6/ReserveNow "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
    connectorId=1 expiry="2026-07-12 12:00" idTag=CERT-TAG-1 || true
}

assert() {
  local log="$1"

  check_log_order "$log" \
    'Sent: \[2,.*"StatusNotification".*"status":"Unavailable"' \
    'Received: \[2,.*"ReserveNow"' \
    "connector Unavailable before ReserveNow"
  check_response_status "$log" "ReserveNow" "Unavailable" \
    "ReserveNow rejected as Unavailable"
  # check_log_after (not check_log_order): the connector's automatic
  # post-boot StatusNotification(Available) always precedes ReserveNow
  # trivially, so a first-occurrence order check would pass even without a
  # real post-ReserveNow reset. Confirm Available appears strictly after the
  # (last) ReserveNow exchange instead.
  check_log_after "$log" \
    'Received: \[2,.*"ReserveNow"' \
    'Sent: \[2,.*"StatusNotification".*"status":"Available"' \
    "reset to Available follows the ReserveNow exchange"
}
