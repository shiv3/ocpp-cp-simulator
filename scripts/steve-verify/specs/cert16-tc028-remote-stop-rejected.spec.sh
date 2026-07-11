#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_028 Remote Stop -- Rejected. Session charging when RemoteStopTransaction
# arrives; scenario's pre-armed override rejects it; charging continues for a
# few seconds, then the CP stops the session locally.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=20

drive() {
  sleep 3
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

  check_log_contains "$log" 'Sent: \[2,.*"StartTransaction".*"idTag":"CERT028"' \
    "StartTransaction sent with idTag CERT028"
  check_response_status "$log" "RemoteStopTransaction" "Rejected" \
    "RemoteStopTransaction rejected"
  check_log_contains "$log" 'Sent: \[2,.*"StopTransaction"' \
    "StopTransaction eventually sent (local stop after rejection, charging continued in between)"

  local tx_pk
  tx_pk="$(db_latest_tx_pk "$CP_ID")"
  check_db_nonempty "SELECT stop_timestamp FROM transaction WHERE transaction_pk=$tx_pk;" \
    "DB: transaction is closed (stop_timestamp set)"
}
