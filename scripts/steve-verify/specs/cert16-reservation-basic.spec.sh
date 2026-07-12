#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_046 Reservation (Basic). CSMS sends ReserveNow (connector goes Reserved
# internally); once the reserved idTag "arrives" the scenario starts a
# transaction using its own hardcoded tagId "CERT-RES01" (independent of
# whatever idTag the ReserveNow itself used), charges with bounded
# MeterValues, then stops.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
# settle(2) + delay-arrival(2) + bounded meter block(30) + tail.
SPEC_HOLD_SECS=45

drive() {
  sleep 2
  steve_op v1.6/ReserveNow "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
    connectorId=1 expiry="$(reservation_expiry_soon)" idTag=CERT-TAG-1 || true
}

assert() {
  local log="$1"

  check_log_contains "$log" 'Received: \[2,.*"ReserveNow"' \
    "ReserveNow.req received"
  check_response_status "$log" "ReserveNow" "Accepted" \
    "ReserveNow accepted"
  check_log_contains "$log" 'Sent: \[2,.*"StartTransaction".*"idTag":"CERT-RES01"' \
    "StartTransaction sent with the scenario's hardcoded idTag CERT-RES01 (not the ReserveNow idTag)"
  check_log_contains "$log" 'Sent: \[2,.*"StopTransaction"' \
    "StopTransaction sent"

  local tx_pk
  tx_pk="$(db_latest_tx_pk "$CP_ID")"
  if [ -z "$tx_pk" ]; then
    _check_fail "DB: transaction row exists for $CP_ID" "no transaction found"
    return
  fi
  _check_pass "DB: transaction row exists for $CP_ID (pk=$tx_pk)"
  check_db_eq "SELECT id_tag FROM transaction WHERE transaction_pk=$tx_pk;" "CERT-RES01" \
    "DB: id_tag is CERT-RES01"
  check_db_nonempty "SELECT stop_timestamp FROM transaction WHERE transaction_pk=$tx_pk;" \
    "DB: transaction is closed (stop_timestamp set)"
}
