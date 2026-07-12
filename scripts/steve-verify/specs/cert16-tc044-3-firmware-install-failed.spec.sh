#!/usr/bin/env bash
# shellcheck disable=SC2034
# TC_044.3 Firmware Update -- Installation Failed -- the scenario arms
# SimulatedFirmwareUpdateFailure=InstallationFailed via a configSet node
# before parking; CSMS sends UpdateFirmware.req; CP progresses Downloading
# -> Downloaded -> Installing, then sends InstallationFailed instead of
# Installed.
#
# See cert16-tc044-1-firmware-update.spec.sh for the retrieveDateTime timing
# rationale (+90s, no-seconds field format).

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

  check_log_contains "$log" 'Sent: \[2,.*"FirmwareStatusNotification".*"status":"Downloading"' \
    "Downloading sent"
  check_log_contains "$log" 'Sent: \[2,.*"FirmwareStatusNotification".*"status":"Downloaded"' \
    "Downloaded sent"
  check_log_contains "$log" 'Sent: \[2,.*"FirmwareStatusNotification".*"status":"Installing"' \
    "Installing sent"
  check_log_contains "$log" 'Sent: \[2,.*"FirmwareStatusNotification".*"status":"InstallationFailed"' \
    "InstallationFailed sent"
  check_log_order "$log" '"status":"Downloading"' '"status":"Downloaded"' \
    "Downloading precedes Downloaded"
  check_log_order "$log" '"status":"Downloaded"' '"status":"Installing"' \
    "Downloaded precedes Installing"
  check_log_order "$log" '"status":"Installing"' '"status":"InstallationFailed"' \
    "Installing precedes InstallationFailed"
  check_log_not_contains "$log" '"status":"Installed"' \
    "Installed (success terminal state) never reached"
}
