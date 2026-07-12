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

  # steve_op only confirms SetChargingProfile was QUEUED -- a fixed sleep
  # here isn't a completion barrier. Wait for the CP's own confirmation
  # that it actually applied the profile (the log literal is
  # SmartChargingHandlers.ts's "Applied charging profile #<id> to
  # connector <n>") before clearing it, so ClearChargingProfile can't race
  # ahead of the profile actually being stored.
  if ! sim_wait_log "$CONTAINER" 'Applied charging profile #1' 10 "SetChargingProfile applied"; then
    log_warn "did not see 'Applied charging profile #1' within 10s -- proceeding anyway, assert() will likely fail"
  fi

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
