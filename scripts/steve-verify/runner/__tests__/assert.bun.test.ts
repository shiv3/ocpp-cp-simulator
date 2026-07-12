import { describe, expect, test } from "bun:test";
import { AssertRecorder, assertResponseStatus } from "../assert";
import { parseLog } from "../ocpp";

// A CP-initiated CALL (e.g. GetDiagnostics.conf on the CP side would never
// CALLERROR in real traffic, but any sent CALL exercises the same code
// path) answered with a CALLERROR instead of a CALLRESULT -- SteVe's
// response to something it can't service.
const SENT_CALL =
  '[2026-07-12T01:18:59.000Z] [INFO] [WebSocket] Sent: [2,"deadbeef-0000","GetDiagnostics",{}]';
const RECEIVED_CALLERROR =
  '[2026-07-12T01:19:00.000Z] [INFO] [WebSocket] Received: [4,"deadbeef-0000","NotSupported","Action not supported",{}]';

describe("assertResponseStatus -- CALLERROR branch", () => {
  test("fails (does not throw/crash) with the CALLERROR's errorCode/description when the paired response is a CALLERROR, not a CALLRESULT", () => {
    const frames = parseLog([SENT_CALL, RECEIVED_CALLERROR].join("\n"));
    const rec = new AssertRecorder();

    assertResponseStatus(
      rec,
      frames,
      "GetDiagnostics",
      "Accepted",
      "GetDiagnostics accepted",
      { direction: "sent" },
    );

    expect(rec.total).toBe(1);
    expect(rec.verdict).toBe("FAIL");
    expect(rec.results[0].pass).toBe(false);
    expect(rec.results[0].detail).toContain("CALLERROR");
    expect(rec.results[0].detail).toContain("NotSupported");
    expect(rec.results[0].detail).toContain("Action not supported");
  });
});
