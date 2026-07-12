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

# Populated by drive(), read back in assert() -- both run in the same shell.
TX_PK=""

drive() {
  # Bind to the ACTIVE transaction CERT028's own StartTransaction created,
  # not db_latest_tx_pk's "newest row regardless of tag/state" -- on a
  # reused charge point that could silently pick up a stale closed
  # transaction from an earlier run instead.
  TX_PK="$(db_wait_active_tx_pk "$CP_ID" CERT028 15)" || true
  if [ -n "$TX_PK" ]; then
    steve_op v1.6/RemoteStopTransaction \
      "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
      transactionId="$TX_PK" || true
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

  if [ -z "$TX_PK" ]; then
    _check_fail "DB: transaction is closed (stop_timestamp set)" "no active transaction found for CERT028"
    return
  fi
  check_db_nonempty "SELECT stop_timestamp FROM transaction WHERE transaction_pk=$TX_PK;" \
    "DB: transaction is closed (stop_timestamp set)"
}
