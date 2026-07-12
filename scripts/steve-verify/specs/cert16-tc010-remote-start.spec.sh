#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_010 Remote Start Transaction -- parks waiting for RemoteStartTransaction;
# on Accepted, StatusNotification(Preparing) -> StartTransaction ->
# StatusNotification(Charging), then bounded MeterValue while charging. No
# tx-stop node in the scenario itself -- drive() cleans up the still-open
# transaction afterward.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=25

drive() {
  sleep 2
  steve_op v1.6/RemoteStartTransaction \
    "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
    connectorId=1 idTag=CERT-TAG-1 chargingProfilePk= || true

  # meter-auto's autoIncrement fires every 5s -- wait long enough for at
  # least one MeterValues to land before cleaning up the still-open
  # transaction (confirmed live: a 3s wait here stopped it before the first
  # increment, producing a false FAIL on "MeterValues sent while charging").
  sleep 8
  local tx_pk
  tx_pk="$(db_latest_tx_pk "$CP_ID")"
  if [ -n "$tx_pk" ]; then
    steve_op v1.6/RemoteStopTransaction \
      "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
      transactionId="$tx_pk" || true
  fi
}

assert() {
  local log="$1"

  check_log_contains "$log" 'Received: \[2,.*"RemoteStartTransaction"' \
    "RemoteStartTransaction.req received"
  check_response_status "$log" "RemoteStartTransaction" "Accepted" \
    "RemoteStartTransaction accepted"
  check_log_order "$log" \
    'Sent: \[2,.*"StatusNotification".*"status":"Preparing"' \
    'Sent: \[2,.*"StartTransaction"' \
    "Preparing precedes StartTransaction"
  check_log_contains "$log" 'Sent: \[2,.*"StartTransaction".*"idTag":"CERT-TAG-1"' \
    "StartTransaction sent with CSMS-supplied idTag (overrides scenario's hardcoded CERT010 fallback)"
  check_log_contains "$log" 'Sent: \[2,.*"MeterValues"' \
    "MeterValues sent while charging"

  local tx_pk
  tx_pk="$(db_latest_tx_pk "$CP_ID")"
  if [ -z "$tx_pk" ]; then
    _check_fail "DB: transaction row exists for $CP_ID with id_tag CERT-TAG-1" "no transaction found"
    return
  fi
  check_db_nonempty "SELECT id_tag FROM transaction WHERE transaction_pk=$tx_pk AND id_tag='CERT-TAG-1';" \
    "DB: transaction row exists for $CP_ID with id_tag CERT-TAG-1"
}
