#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_004 Charging Session (Identification First) -- idTag presented before
# plug-in; fully CP-driven, no CSMS operator action.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
# delay-idtag(2s) + bounded meter block(30s) + tail.
SPEC_HOLD_SECS=40

# No drive(): nothing for the CSMS operator to do.

assert() {
  local log="$1"

  check_log_contains "$log" 'Sent: \[2,.*"StartTransaction".*"idTag":"CERT004"' \
    "StartTransaction sent with idTag CERT004"
  check_log_contains "$log" 'Received: \[3,.*"idTagInfo":{"status":"Accepted"' \
    "StartTransaction accepted by SteVe"
  check_log_contains "$log" 'Sent: \[2,.*"MeterValues"' \
    "MeterValues sent while charging"
  check_log_order "$log" \
    'Sent: \[2,.*"MeterValues"' \
    'Sent: \[2,.*"StopTransaction"' \
    "MeterValues precede StopTransaction"
  check_log_contains "$log" 'Sent: \[2,.*"StatusNotification".*"status":"Available"' \
    "final StatusNotification(Available) sent"

  local tx_pk
  tx_pk="$(db_latest_tx_pk "$CP_ID")"
  if [ -z "$tx_pk" ]; then
    _check_fail "DB: transaction row exists for $CP_ID" "no transaction found"
    return
  fi
  _check_pass "DB: transaction row exists for $CP_ID (pk=$tx_pk)"
  check_db_eq "SELECT id_tag FROM transaction WHERE transaction_pk=$tx_pk;" "CERT004" \
    "DB: id_tag is CERT004"
  check_db_nonempty "SELECT stop_timestamp FROM transaction WHERE transaction_pk=$tx_pk;" \
    "DB: transaction is closed (stop_timestamp set)"
}
