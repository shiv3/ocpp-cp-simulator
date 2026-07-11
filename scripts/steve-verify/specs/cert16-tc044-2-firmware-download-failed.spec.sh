#!/usr/bin/env bash
# shellcheck disable=SC2034
# TC_044.2 Firmware Update -- Download Failed -- the scenario arms
# SimulatedFirmwareUpdateFailure=DownloadFailed via a configSet node before
# parking (nothing for drive() to arm); CSMS sends UpdateFirmware.req; CP
# sends Downloading then DownloadFailed and stops -- Installing/Installed
# are never reached.
#
# See cert16-tc044-1-firmware-update.spec.sh for the retrieveDateTime timing
# rationale (+90s, no-seconds field format).

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=110

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
  check_log_contains "$log" 'Sent: \[2,.*"FirmwareStatusNotification".*"status":"DownloadFailed"' \
    "DownloadFailed sent"
  check_log_order "$log" '"status":"Downloading"' '"status":"DownloadFailed"' \
    "Downloading precedes DownloadFailed"
  check_log_not_contains "$log" '"status":"Installing"' \
    "Installing never reached"
  check_log_not_contains "$log" '"status":"Installed"' \
    "Installed never reached"
}
