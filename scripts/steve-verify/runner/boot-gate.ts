/**
 * Boot gate: matches a BootNotification.conf CALLRESULT — a CALLRESULT (`[3,`)
 * carrying both `status: "Accepted"` and `currentTime` — in the CLI's
 * WebSocket log line, regardless of JSON key order.
 *
 * JSON key order is not semantically meaningful and varies by CSMS: SteVe
 * serialises `{status, currentTime, interval}`, others `{currentTime, interval,
 * status}`. An order-fixed pattern only matches SteVe, so against another CSMS
 * the event-driven gate silently degrades to the plain `bootWaitSecs` sleep it
 * exists to replace (issue #262). The two lookaheads scan the frame body (up to
 * the closing `]`) for each key independently, so any order matches.
 */
export const BOOT_ACCEPTED_PATTERN =
  /Received: \[3,(?=[^\]]*"status":"Accepted")(?=[^\]]*"currentTime")/;
