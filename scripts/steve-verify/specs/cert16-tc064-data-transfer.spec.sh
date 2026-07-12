#!/usr/bin/env bash
# SPEC_* vars below are consumed by run-scenario.sh after sourcing this
# file, not used within it.
# shellcheck disable=SC2034
# TC_064 Data Transfer to Central System -- CP sends DataTransfer.req
# unprompted; the CSMS's response status is SteVe's own policy (not CP
# behavior under test), so it's asserted loosely -- see README "Known
# limitations".

SPEC_CONNECTOR=1
SPEC_BOOT_WAIT=4
SPEC_HOLD_SECS=10

# No drive(): CP-initiated, nothing for the CSMS operator to send.

assert() {
  local log="$1"

  check_log_contains "$log" 'Sent: \[2,.*"DataTransfer".*"vendorId":"com.example.cert16".*"messageId":"certTest".*"data":"hello-csms"' \
    "DataTransfer.req sent with expected vendorId/messageId/data"
  check_sent_result "$log" "DataTransfer" '"status":"(Accepted|Rejected|UnknownVendorId)"' \
    "DataTransfer.conf received (status is SteVe's own policy, not asserted)"
}
