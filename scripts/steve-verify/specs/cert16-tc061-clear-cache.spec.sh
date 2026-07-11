#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_061 Clear Authorization Cache -- CSMS sends ClearCache, CP accepts.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=15

drive() {
  sleep 2
  steve_op v1.6/ClearCache "chargePointSelectList=$(steve_cp_select "$CP_ID")" || true
}

assert() {
  local log="$1"

  check_log_contains "$log" 'Received: \[2,.*"ClearCache"' \
    "ClearCache.req received"
  check_response_status "$log" "ClearCache" "Accepted" \
    "ClearCache accepted"
}
