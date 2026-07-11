#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_024 Start Charging Session -- Lock Failure -- fully CP-driven: plug in,
# CP reports Faulted/ConnectorLockFailure with no transaction started, plug
# out. No CSMS operator action.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=12

# No drive(): nothing for the CSMS operator to do.

assert() {
  local log="$1"

  # Field order on the wire is errorCode before status (confirmed live), so
  # match them independently rather than assuming an order.
  check_log_contains "$log" 'Sent: \[2,.*"StatusNotification".*"errorCode":"ConnectorLockFailure".*"status":"Faulted"' \
    "StatusNotification(Faulted, ConnectorLockFailure) sent"
  check_log_not_contains "$log" 'Sent: \[2,.*"StartTransaction"' \
    "no StartTransaction sent (lock failure prevents charging)"
  check_log_contains "$log" 'Sent: \[2,.*"StatusNotification".*"status":"Available"' \
    "final StatusNotification(Available) sent after plug-out"
}
