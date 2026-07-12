#!/usr/bin/env bash
# shellcheck disable=SC2034
# TC_044.1 Firmware Update -- Download and Install -- CSMS sends
# UpdateFirmware.req; the CP genuinely waits until wall-clock retrieveDate
# before starting the FirmwareStatusNotification train (confirmed live:
# this is correct OCPP 1.6 semantics, not a bug), then progresses
# Downloading -> Downloaded -> Installing -> Installed.
#
# retrieveDateTime has no seconds field ("YYYY-MM-DD HH:MM"), so a short
# "+N seconds" offset can round into the current (already-past) minute --
# use +90s to guarantee landing in a strictly future minute regardless of
# where in the current minute drive() runs. SPEC_HOLD_SECS covers that wait
# plus the ~10s status train plus a tail buffer.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=115

retrieve_datetime_soon() {
  date -u -v+90S +"%Y-%m-%d %H:%M" 2>/dev/null || date -u -d "+90 seconds" +"%Y-%m-%d %H:%M"
}

drive() {
  sleep 2
  steve_op v1.6/UpdateFirmware "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
    location=http://example.com/fw.bin retrieveDateTime="$(retrieve_datetime_soon)" || true
}

assert() {
  local log="$1"

  check_log_contains "$log" 'Received: \[2,.*"UpdateFirmware"' \
    "UpdateFirmware.req received"
  check_log_contains "$log" 'Sent: \[2,.*"FirmwareStatusNotification".*"status":"Downloading"' \
    "Downloading sent"
  check_log_contains "$log" 'Sent: \[2,.*"FirmwareStatusNotification".*"status":"Downloaded"' \
    "Downloaded sent"
  check_log_contains "$log" 'Sent: \[2,.*"FirmwareStatusNotification".*"status":"Installing"' \
    "Installing sent"
  check_log_contains "$log" 'Sent: \[2,.*"FirmwareStatusNotification".*"status":"Installed"' \
    "Installed sent"
  check_log_order "$log" '"status":"Downloading"' '"status":"Downloaded"' \
    "Downloading precedes Downloaded"
  check_log_order "$log" '"status":"Downloaded"' '"status":"Installing"' \
    "Downloaded precedes Installing"
  check_log_order "$log" '"status":"Installing"' '"status":"Installed"' \
    "Installing precedes Installed"
}
