#!/usr/bin/env bash
# shellcheck disable=SC2034
# TC_045.1 Get Diagnostics -- CSMS sends GetDiagnostics.req with an upload
# location; CP responds with a fileName and sends DiagnosticsStatusNotification
# (Uploading, then Uploaded/UploadFailed depending on the HTTP response).
#
# This spec's location (http://example.com/upload) is not a real upload
# endpoint, so UploadFailed is the EXPECTED outcome here (confirmed live:
# the location 404/405s) -- not a defect. Both outcomes are
# certification-relevant per the scenario's own description; this spec
# pins UploadFailed since that's what this harness's location produces.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=25

drive() {
  sleep 2
  steve_op v1.6/GetDiagnostics "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
    location=http://example.com/upload || true
}

assert() {
  local log="$1"

  check_log_contains "$log" 'Received: \[2,.*"GetDiagnostics"' \
    "GetDiagnostics.req received"
  check_log_contains "$log" 'Sent: \[3,.*"fileName":"diagnostics.txt"' \
    "GetDiagnostics.conf returns fileName"
  check_log_contains "$log" 'Sent: \[2,.*"DiagnosticsStatusNotification".*"status":"Uploading"' \
    "DiagnosticsStatusNotification(Uploading) sent"
  check_log_contains "$log" 'Sent: \[2,.*"DiagnosticsStatusNotification".*"status":"UploadFailed"' \
    "DiagnosticsStatusNotification(UploadFailed) sent (unreachable location, expected outcome)"
  check_log_order "$log" '"status":"Uploading"' '"status":"UploadFailed"' \
    "Uploading precedes UploadFailed"
}
