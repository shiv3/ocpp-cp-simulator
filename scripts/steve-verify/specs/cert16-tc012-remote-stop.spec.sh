#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_012 Remote Stop Transaction -- locally-started session (StartTransaction
# + running MeterValue) already Charging when RemoteStopTransaction arrives.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=18

drive() {
  sleep 4
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

  check_log_contains "$log" 'Sent: \[2,.*"StartTransaction".*"idTag":"CERT012"' \
    "StartTransaction sent with idTag CERT012 (self-driven, not remote-started)"
  check_response_status "$log" "RemoteStopTransaction" "Accepted" \
    "RemoteStopTransaction accepted"
  check_log_contains "$log" 'Sent: \[2,.*"StopTransaction".*"reason":"Remote"' \
    "StopTransaction sent with reason Remote"

  local tx_pk
  tx_pk="$(db_latest_tx_pk "$CP_ID")"
  check_db_eq "SELECT id_tag FROM transaction WHERE transaction_pk=$tx_pk;" "CERT012" \
    "DB: id_tag is CERT012"
  check_db_nonempty "SELECT stop_timestamp FROM transaction WHERE transaction_pk=$tx_pk;" \
    "DB: transaction is closed (stop_timestamp set)"
}
