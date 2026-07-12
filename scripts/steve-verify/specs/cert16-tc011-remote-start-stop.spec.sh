#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_011 Remote Start + Remote Stop Transaction -- RemoteStartTransaction ->
# Preparing -> StartTransaction -> Charging with running MeterValue; on
# RemoteStopTransaction, StopTransaction -> Finishing -> Available.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=20

drive() {
  sleep 2
  steve_op v1.6/RemoteStartTransaction \
    "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
    connectorId=1 idTag=CERT-TAG-2 chargingProfilePk= || true

  sleep 3
  local tx_pk
  tx_pk="$(db_latest_tx_pk "$CP_ID")"

  sleep 2
  if [ -n "$tx_pk" ]; then
    steve_op v1.6/RemoteStopTransaction \
      "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
      transactionId="$tx_pk" || true
  fi
}

assert() {
  local log="$1"

  check_response_status "$log" "RemoteStartTransaction" "Accepted" \
    "RemoteStartTransaction accepted"
  check_log_contains "$log" 'Sent: \[2,.*"StartTransaction".*"idTag":"CERT-TAG-2"' \
    "StartTransaction sent with CSMS-supplied idTag"
  check_response_status "$log" "RemoteStopTransaction" "Accepted" \
    "RemoteStopTransaction accepted"
  check_log_contains "$log" 'Sent: \[2,.*"StopTransaction".*"reason":"Remote"' \
    "StopTransaction sent with reason Remote"

  local tx_pk
  tx_pk="$(db_latest_tx_pk "$CP_ID")"
  if [ -z "$tx_pk" ]; then
    _check_fail "DB: transaction is closed (stop_timestamp set)" "no transaction found"
    return
  fi
  check_db_nonempty "SELECT stop_timestamp FROM transaction WHERE transaction_pk=$tx_pk;" \
    "DB: transaction is closed (stop_timestamp set)"
}
