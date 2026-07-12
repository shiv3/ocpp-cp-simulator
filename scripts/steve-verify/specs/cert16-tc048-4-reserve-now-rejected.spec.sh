#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_048.4 ReserveNow -- Rejected. Connector Available; scenario pre-arms a
# Rejected responseOverride (CP configured to not accept reservations); CSMS
# sends ReserveNow; CP must answer Rejected.

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

  check_log_contains "$log" 'Received: \[2,.*"ReserveNow"' \
    "ReserveNow.req received"
  check_response_status "$log" "ReserveNow" "Rejected" \
    "ReserveNow rejected"
}
