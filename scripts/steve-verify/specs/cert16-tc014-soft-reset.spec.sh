#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_014 Soft Reset -- CSMS sends Reset(type=Soft) during charging; CP stops
# the transaction with SoftReset reason and reboots on the SAME socket (no
# WS disconnect/reconnect, unlike Hard Reset).

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=25

drive() {
  sleep 3
  steve_op v1.6/Reset "chargePointSelectList=$(steve_cp_select "$CP_ID")" resetType=SOFT || true
}

assert() {
  local log="$1"

  check_log_contains "$log" 'Received: \[2,.*"Reset".*"type":"Soft"' \
    "Reset(Soft).req received"
  check_response_status "$log" "Reset" "Accepted" \
    "Reset accepted"
  check_log_contains "$log" 'Sent: \[2,.*"StopTransaction"' \
    "StopTransaction sent"

  local tx_pk
  tx_pk="$(db_latest_tx_pk "$CP_ID")"
  if [ -z "$tx_pk" ]; then
    _check_fail "DB: transaction row exists for $CP_ID" "no transaction found"
    return
  fi
  check_db_eq "SELECT stop_reason FROM transaction WHERE transaction_pk=$tx_pk;" "SoftReset" \
    "DB: stop_reason is SoftReset"
}
