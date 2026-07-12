#!/usr/bin/env bash
# shellcheck disable=SC2034
# TC_045.1 Get Diagnostics -- CSMS sends GetDiagnostics.req with an upload
# location; CP responds with a fileName and sends DiagnosticsStatusNotification
# (Uploading, then Uploaded/UploadFailed depending on the HTTP response).
#
# GetDiagnosticsHandler really does `fetch()` the location (see
# src/cp/infrastructure/transport/handlers/call/GetDiagnosticsHandler.ts --
# unlike UpdateFirmware, which never dereferences its `location`), so this
# spec's target must stay reachable-but-failing without any real DNS/egress
# dependency. `http://app:9/upload` -- SteVe's own app container, port 9 is
# nothing listens there -- gets an instant, deterministic connection-refused
# on the steve_default docker network (no external network needed at all),
# so UploadFailed is the EXPECTED and hermetic outcome here, not a defect.

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=25

drive() {
  sleep 2
  steve_op v1.6/GetDiagnostics "chargePointSelectList=$(steve_cp_select "$CP_ID")" \
    location=http://app:9/upload || true
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
