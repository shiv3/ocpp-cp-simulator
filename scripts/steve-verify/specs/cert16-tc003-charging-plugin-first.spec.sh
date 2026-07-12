#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_003 Charging Session (Plug-In First) -- fully CP-driven: plug in, wait,
# present idTag CERT003, charge with bounded MeterValues (30s), stop, plug
# out. No CSMS-side operator action; asserted from the wire log + DB.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
# delay-connect(2s) + delay-idtag(2s) + bounded meter block(30s) + tail.
SPEC_HOLD_SECS=45

# No drive(): nothing for the CSMS operator to do.

assert() {
  local log="$1"

  check_log_order "$log" \
    'Sent: \[2,.*"StatusNotification".*"status":"Preparing"' \
    'Sent: \[2,.*"StartTransaction"' \
    "Preparing precedes StartTransaction"
  check_log_contains "$log" 'Sent: \[2,.*"StartTransaction".*"idTag":"CERT003"' \
    "StartTransaction sent with idTag CERT003"
  check_log_contains "$log" 'Received: \[3,.*"idTagInfo":{"status":"Accepted"' \
    "StartTransaction accepted by SteVe"
  check_log_contains "$log" 'Sent: \[2,.*"MeterValues"' \
    "MeterValues sent while charging"
  check_log_order "$log" \
    'Sent: \[2,.*"MeterValues"' \
    'Sent: \[2,.*"StopTransaction"' \
    "MeterValues precede StopTransaction"
  check_log_contains "$log" 'Sent: \[2,.*"StopTransaction"' \
    "StopTransaction sent"
  check_log_contains "$log" 'Sent: \[2,.*"StatusNotification".*"status":"Available"' \
    "final StatusNotification(Available) sent"

  local tx_pk
  tx_pk="$(db_latest_tx_pk "$CP_ID")"
  if [ -z "$tx_pk" ]; then
    _check_fail "DB: transaction row exists for $CP_ID" "no transaction found"
    return
  fi
  _check_pass "DB: transaction row exists for $CP_ID (pk=$tx_pk)"
  check_db_eq "SELECT id_tag FROM transaction WHERE transaction_pk=$tx_pk;" "CERT003" \
    "DB: id_tag is CERT003"
  check_db_nonempty "SELECT stop_timestamp FROM transaction WHERE transaction_pk=$tx_pk;" \
    "DB: transaction is closed (stop_timestamp set)"
}
