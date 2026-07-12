#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_059 Remote Start with Charging Profile -- CSMS sends
# RemoteStartTransaction with an attached TxProfile (chargingProfilePk=2,
# the only purpose SteVe will attach to this op). Per OCPP 5.11 a Core-only
# CP may accept the start but not store/apply the profile -- that's the
# load-bearing assertion here.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
# meter-auto blocks 30s before tx-stop + tail.
SPEC_HOLD_SECS=40

drive() {
  sleep 2
  steve_op v1.6/RemoteStartTransaction \
    "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
    connectorId=1 idTag=CERT-TAG-1 chargingProfilePk=2 || true
}

assert() {
  local log="$1"

  check_response_status "$log" "RemoteStartTransaction" "Accepted" \
    "RemoteStartTransaction (with attached TxProfile) accepted"
  check_log_contains "$log" 'Sent: \[2,.*"StartTransaction"' \
    "StartTransaction sent"
  # Narrowed to profile #2 specifically (the log's actual format is
  # "Applied charging profile #<id> to connector <n>", confirmed against
  # SmartChargingHandlers.ts) -- a bare 'Applied charging profile' would
  # also fail this scenario on an unrelated profile (e.g. #1 from another
  # spec's leftover state) being applied, which isn't what this assertion
  # is about.
  check_log_not_contains "$log" 'Applied charging profile #2 to connector' \
    "attached profile #2 is accepted but NOT stored/applied (Core CP may ignore SmartCharging profiles per OCPP 5.11)"
  check_log_contains "$log" 'Sent: \[2,.*"StopTransaction"' \
    "StopTransaction eventually sent"

  local tx_pk
  tx_pk="$(db_latest_tx_pk "$CP_ID")"
  if [ -z "$tx_pk" ]; then
    _check_fail "DB: transaction is closed (stop_timestamp set)" "no transaction found"
    return
  fi
  check_db_nonempty "SELECT stop_timestamp FROM transaction WHERE transaction_pk=$tx_pk;" \
    "DB: transaction is closed (stop_timestamp set)"
}
