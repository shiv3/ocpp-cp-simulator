#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_056 Central Smart Charging -- TxDefaultProfile. Charging session runs;
# CSMS sends SetChargingProfile (TxDefaultProfile, connector 1); CP stores
# and applies it, then the scenario stops the transaction.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
# tx-start settle(3s) + csmsCallTrigger + 10s delay-before-stop + tail.
SPEC_HOLD_SECS=25

TX_PK=""

drive() {
  sleep 3
  TX_PK="$(db_latest_tx_pk "$CP_ID")"
  steve_op v1.6/SetChargingProfile \
    "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
    chargingProfilePk=1 connectorId=1 transactionId= || true
}

assert() {
  local log="$1"

  check_log_contains "$log" 'Sent: \[2,.*"StartTransaction".*"idTag":"CERT056"' \
    "StartTransaction sent with idTag CERT056"
  check_response_status "$log" "SetChargingProfile" "Accepted" \
    "SetChargingProfile (TxDefaultProfile) accepted"
  check_log_contains "$log" 'Applied charging profile #1' \
    "CP applied the TxDefaultProfile"
  check_log_contains "$log" 'Sent: \[2,.*"StopTransaction"' \
    "StopTransaction eventually sent"

  local tx_pk="${TX_PK:-$(db_latest_tx_pk "$CP_ID")}"
  check_db_nonempty "SELECT stop_timestamp FROM transaction WHERE transaction_pk=$tx_pk;" \
    "DB: transaction is closed (stop_timestamp set)"
}
