#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_052 Cancel Reservation -- Rejected. CSMS sends CancelReservation for a
# reservationId that does not exist; core CancelReservationHandler answers
# Rejected (no override needed).

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=12

drive() {
  sleep 2
  steve_op v1.6/CancelReservation "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
    reservationId=99999 || true
}

assert() {
  local log="$1"

  check_log_contains "$log" 'Received: \[2,.*"CancelReservation"' \
    "CancelReservation.req received"
  check_response_status "$log" "CancelReservation" "Rejected" \
    "CancelReservation rejected (nonexistent reservationId)"
}
