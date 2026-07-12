#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_018 Unlock Connector (Failure) -- session running; scenario pre-arms
# its next UnlockConnector.req response as UnlockFailed; CSMS sends
# UnlockConnector while charging; session STILL completes normally (the
# unlock itself failing doesn't fail the charging session).
#
# Same timing window as TC_017 -- see that spec for the derivation.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=35

drive() {
  sleep 20
  steve_op v1.6/UnlockConnector "chargePointSelectList=$(steve_cp_select "$CP_ID")" connectorId=1 || true
}

assert() {
  local log="$1"

  check_log_contains "$log" 'Received: \[2,.*"UnlockConnector"' \
    "UnlockConnector.req received"
  check_response_status "$log" "UnlockConnector" "UnlockFailed" \
    "UnlockConnector -> UnlockFailed"
  check_log_contains "$log" 'Sent: \[2,.*"StopTransaction"' \
    "StopTransaction sent (session completes normally despite unlock failure)"

  local tx_pk
  tx_pk="$(db_latest_tx_pk "$CP_ID")"
  if [ -z "$tx_pk" ]; then
    _check_fail "DB: transaction row exists for $CP_ID" "no transaction found"
    return
  fi
  check_db_nonempty "SELECT stop_timestamp FROM transaction WHERE transaction_pk=$tx_pk;" \
    "DB: transaction is closed (stop_timestamp set)"
}
