#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_051 Cancel Reservation (Accepted). CSMS sends ReserveNow, then
# CancelReservation for the reservation it just created; CP core flips
# Reserved -> Available internally (no separate wire StatusNotification for
# that transition -- only the DB status changes).

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=20

# Populated by drive(), read back in assert() -- both run in the same shell.
RESV_PK=""

# steve_op only confirms ReserveNow was QUEUED, not that SteVe has finished
# writing the reservation row -- a one-shot db_latest_reservation_pk right
# after queuing it can race the DB write and capture an empty/stale PK.
_tc051_reservation_exists() {
  RESV_PK="$(db_latest_reservation_pk "$CP_ID")"
  [ -n "$RESV_PK" ]
}

drive() {
  sleep 2
  steve_op v1.6/ReserveNow "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
    connectorId=1 expiry="$(reservation_expiry_soon)" idTag=CERT-TAG-1 || true
  wait_for_condition 15 1 "reservation row for $CP_ID exists" -- _tc051_reservation_exists
  steve_op v1.6/CancelReservation "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
    reservationId="$RESV_PK" || true
}

assert() {
  local log="$1"

  check_response_status "$log" "ReserveNow" "Accepted" \
    "ReserveNow accepted"
  check_response_status "$log" "CancelReservation" "Accepted" \
    "CancelReservation accepted"

  if [ -z "$RESV_PK" ]; then
    _check_fail "DB: reservation id captured" "db_latest_reservation_pk returned empty"
    return
  fi
  check_db_eq "SELECT status FROM reservation WHERE reservation_pk=$RESV_PK;" "CANCELLED" \
    "DB: reservation $RESV_PK is CANCELLED"
}
