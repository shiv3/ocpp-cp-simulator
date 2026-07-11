#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_066 Get Composite Schedule -- SetChargingProfile then GetCompositeSchedule
# in sequence (tests dual-park re-entry in the scenario engine). Both must be
# accepted; the returned schedule should reflect the applied profile.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=15

drive() {
  sleep 2
  steve_op v1.6/SetChargingProfile \
    "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
    chargingProfilePk=1 connectorId=1 transactionId= || true

  sleep 2
  steve_op v1.6/GetCompositeSchedule \
    "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
    connectorId=1 durationInSeconds=600 chargingRateUnit=W || true
}

assert() {
  local log="$1"

  check_response_status "$log" "SetChargingProfile" "Accepted" \
    "SetChargingProfile accepted"
  check_response_status "$log" "GetCompositeSchedule" "Accepted" \
    "GetCompositeSchedule accepted"
  check_log_contains "$log" 'Sent: \[3,.*"chargingSchedule".*"limit":11000' \
    "returned schedule reflects the applied profile's period (limit 11000)"
}
