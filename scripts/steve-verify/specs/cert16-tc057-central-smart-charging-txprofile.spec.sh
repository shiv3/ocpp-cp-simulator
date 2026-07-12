#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_057 Central Smart Charging -- TxProfile. Charging session runs; CSMS
# sends SetChargingProfile (TxProfile, for the running transaction); CP
# stores and applies it, then the scenario stops the transaction.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=25

TX_PK=""

drive() {
  # Bind to the ACTIVE transaction CERT057's own StartTransaction created,
  # not db_latest_tx_pk's "newest row regardless of tag/state" -- on a
  # reused charge point that could silently pick up a stale closed
  # transaction from an earlier run instead (and the TxProfile is only
  # meaningful attached to the actual running transaction).
  TX_PK="$(db_wait_active_tx_pk "$CP_ID" CERT057 15)" || true
  steve_op v1.6/SetChargingProfile \
    "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
    chargingProfilePk=2 connectorId=1 transactionId="$TX_PK" || true
}

assert() {
  local log="$1"

  check_log_contains "$log" 'Sent: \[2,.*"StartTransaction".*"idTag":"CERT057"' \
    "StartTransaction sent with idTag CERT057"
  check_response_status "$log" "SetChargingProfile" "Accepted" \
    "SetChargingProfile (TxProfile) accepted"
  check_log_contains "$log" 'Applied charging profile #2' \
    "CP applied the TxProfile"
  check_log_contains "$log" 'Sent: \[2,.*"StopTransaction"' \
    "StopTransaction eventually sent"

  if [ -z "$TX_PK" ]; then
    _check_fail "DB: transaction is closed (stop_timestamp set)" "no active transaction found for CERT057"
    return
  fi
  check_db_nonempty "SELECT stop_timestamp FROM transaction WHERE transaction_pk=$TX_PK;" \
    "DB: transaction is closed (stop_timestamp set)"
}
