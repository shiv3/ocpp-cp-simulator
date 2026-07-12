#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_026 Remote Start -- Rejected. Scenario arms a responseOverride
# (RemoteStartTransaction -> Rejected) before parking on the trigger; the
# CSMS sends RemoteStartTransaction on an Available connector and must see
# Rejected with no StartTransaction/transaction row created.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=15

# Populated by drive(), read back in assert() -- both run in the same shell.
BASELINE_TX_PK=""

drive() {
  BASELINE_TX_PK="$(db_latest_tx_pk "$CP_ID")"
  sleep 2
  steve_op v1.6/RemoteStartTransaction \
    "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
    connectorId=1 idTag=CERT-TAG-1 chargingProfilePk= || true
}

assert() {
  local log="$1"

  check_log_contains "$log" 'Received: \[2,.*"RemoteStartTransaction"' \
    "RemoteStartTransaction.req received"
  check_response_status "$log" "RemoteStartTransaction" "Rejected" \
    "RemoteStartTransaction rejected"
  check_log_not_contains "$log" 'Sent: \[2,.*"StartTransaction"' \
    "no StartTransaction sent"

  local after
  after="$(db_latest_tx_pk "$CP_ID")"
  check_eq "$after" "$BASELINE_TX_PK" \
    "DB: no new transaction row created for $CP_ID"
}
