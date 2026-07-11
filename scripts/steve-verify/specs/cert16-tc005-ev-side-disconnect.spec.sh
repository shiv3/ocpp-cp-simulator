#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_005 EV Side Disconnected -- fully CP-driven: plug in, charge, EV-side
# disconnect (plugout) mid-charge, StopTransaction with EVDisconnected
# reason. No CSMS operator action.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
# bounded meter block(15s) + tail.
SPEC_HOLD_SECS=25

# No drive(): nothing for the CSMS operator to do.

assert() {
  local log="$1"

  check_log_contains "$log" 'Sent: \[2,.*"StartTransaction".*"idTag":"CERT005"' \
    "StartTransaction sent with idTag CERT005"
  check_log_contains "$log" 'Sent: \[2,.*"MeterValues"' \
    "MeterValues sent while charging"
  check_log_contains "$log" 'Sent: \[2,.*"StopTransaction".*"reason":"EVDisconnected"' \
    "StopTransaction sent with reason EVDisconnected"

  local tx_pk
  tx_pk="$(db_latest_tx_pk "$CP_ID")"
  if [ -z "$tx_pk" ]; then
    _check_fail "DB: transaction row exists for $CP_ID" "no transaction found"
    return
  fi
  _check_pass "DB: transaction row exists for $CP_ID (pk=$tx_pk)"
  check_db_eq "SELECT id_tag FROM transaction WHERE transaction_pk=$tx_pk;" "CERT005" \
    "DB: id_tag is CERT005"
  check_db_eq "SELECT stop_reason FROM transaction WHERE transaction_pk=$tx_pk;" "EVDisconnected" \
    "DB: stop_reason is EVDisconnected"
}
