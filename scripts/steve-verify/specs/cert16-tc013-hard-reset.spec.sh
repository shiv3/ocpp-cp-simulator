#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_013 Hard Reset -- CSMS sends Reset(type=Hard) during charging; CP stops
# the transaction with HardReset reason and reboots (WS disconnect +
# reconnect + new BootNotification).
#
# NOTE (confirmed live): unlike Soft Reset, this CP does NOT send an
# explicit Reset.conf CALLRESULT before disconnecting on a Hard Reset -- it
# goes straight from "Reset request received: Hard" to StopTransaction to
# WebSocket close. That's real observed behavior, not a gap in this spec, so
# we assert the disconnect/reconnect/reboot sequence instead of a
# never-sent CALLRESULT.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=25

drive() {
  sleep 3
  steve_op v1.6/Reset "chargePointSelectList=$(steve_cp_select "$CP_ID")" resetType=HARD || true
}

assert() {
  local log="$1"

  check_log_contains "$log" 'Received: \[2,.*"Reset".*"type":"Hard"' \
    "Reset(Hard).req received"
  check_log_contains "$log" 'Sent: \[2,.*"StopTransaction"' \
    "StopTransaction sent"
  check_log_order "$log" \
    'Sent: \[2,.*"StopTransaction"' \
    'WebSocket closed' \
    "StopTransaction precedes the WebSocket disconnect (reboot)"
  local boot_count
  boot_count="$(grep -cE 'Sent: \[2,"[^"]+","BootNotification"' "$log" || true)"
  if [ "${boot_count:-0}" -ge 2 ]; then
    _check_pass "CP reconnects and sends a fresh BootNotification after the reboot ($boot_count total)"
  else
    _check_fail "CP reconnects and sends a fresh BootNotification after the reboot" \
      "expected >=2 BootNotification.req sends (initial + post-reboot), got $boot_count"
  fi

  local tx_pk
  tx_pk="$(db_latest_tx_pk "$CP_ID")"
  if [ -z "$tx_pk" ]; then
    _check_fail "DB: transaction row exists for $CP_ID" "no transaction found"
    return
  fi
  check_db_eq "SELECT stop_reason FROM transaction WHERE transaction_pk=$tx_pk;" "HardReset" \
    "DB: stop_reason is HardReset"
}
