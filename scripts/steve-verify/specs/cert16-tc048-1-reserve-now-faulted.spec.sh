#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_048.1 ReserveNow -- Faulted. Connector forced Faulted; scenario pre-arms
# a Faulted responseOverride; CSMS sends ReserveNow; CP must answer Faulted,
# then reset to Available.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=12

drive() {
  sleep 2
  steve_op v1.6/ReserveNow "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
    connectorId=1 expiry="$(reservation_expiry_soon)" idTag=CERT-TAG-1 || true
}

assert() {
  local log="$1"

  # Field order on the wire is errorCode before status (confirmed live on
  # cert16-tc024-lock-failure's identical statusNotification node type), so
  # match them independently rather than assuming an order.
  check_log_contains "$log" 'Sent: \[2,.*"StatusNotification".*"errorCode":"InternalError".*"status":"Faulted"' \
    "connector forced Faulted before ReserveNow"
  check_response_status "$log" "ReserveNow" "Faulted" \
    "ReserveNow rejected as Faulted"
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
