#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_067 Clear Charging Profile -- CSMS sends SetChargingProfile (stored),
# then ClearChargingProfile; CP clears the profile and confirms Accepted.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=15

drive() {
  sleep 2
  steve_op v1.6/SetChargingProfile \
    "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
    chargingProfilePk=1 connectorId=1 transactionId= || true

  sleep 2
  steve_op v1.6/ClearChargingProfile \
    "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
    chargingProfilePk=1 || true
}

assert() {
  local log="$1"

  check_response_status "$log" "SetChargingProfile" "Accepted" \
    "SetChargingProfile accepted"
  check_response_status "$log" "ClearChargingProfile" "Accepted" \
    "ClearChargingProfile accepted"
  check_log_contains "$log" 'Cleared.*profile' \
    "CP logged clearing the stored profile"
}
