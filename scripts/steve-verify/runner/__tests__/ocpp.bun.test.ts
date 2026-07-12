import { describe, expect, test } from "bun:test";
import { findCall, findResponseFor, parseLog, parseLogLine } from "../ocpp";
import type { CallFrame } from "../ocpp";

// Real sample lines captured from a live SteVe run (see
// scripts/steve-verify/results/cert16-tc026-remote-start-rejected.log),
// trimmed to what the parser needs to exercise.
const SENT_BOOT =
  '[2026-07-12T01:17:58.179Z] [INFO] [WebSocket] Sent: [2,"102f1228-84cd-449e-9ccf-c1bcd4d5be7d","BootNotification",{"chargePointVendor":"CLI-Vendor","chargePointModel":"CLI-Model"}]';
const RECEIVED_BOOT_RESULT =
  '[2026-07-12T01:17:58.189Z] [INFO] [WebSocket] Received: [3,"102f1228-84cd-449e-9ccf-c1bcd4d5be7d",{"status":"Accepted","currentTime":"2026-07-12T01:17:58.182Z","interval":14400}]';
const RECEIVED_REMOTE_START =
  '[2026-07-12T01:18:03.472Z] [INFO] [WebSocket] Received: [2,"b22b934f-daa8-472d-94db-9f8cb3b16a10","RemoteStartTransaction",{"connectorId":1,"idTag":"CERT-TAG-1"}]';
const SENT_REMOTE_START_REJECTED =
  '[2026-07-12T01:18:03.473Z] [INFO] [WebSocket] Sent: [3,"b22b934f-daa8-472d-94db-9f8cb3b16a10",{"status":"Rejected"}]';
const NON_FRAME_LOG_LINE =
  "[2026-07-12T01:17:58.147Z] [INFO] [WebSocket] WebSocket connected successfully";
const STRUCTURED_EVENT_LINE =
  '{"event":"scenario_started","data":{"connectorId":1,"scenarioId":"abc"},"timestamp":"2026-07-12T01:18:01.194Z"}';
const COMMAND_RESPONSE_LINE = '{"id":null,"ok":true}';
const CALLERROR_LINE =
  '[2026-07-12T01:19:00.000Z] [INFO] [WebSocket] Received: [4,"deadbeef-0000","NotSupported","Action not supported",{}]';

describe("parseLogLine", () => {
  test("parses a Sent CALL line", () => {
    const frame = parseLogLine(SENT_BOOT);
    expect(frame).toEqual({
      kind: "call",
      direction: "sent",
      uniqueId: "102f1228-84cd-449e-9ccf-c1bcd4d5be7d",
      action: "BootNotification",
      payload: {
        chargePointVendor: "CLI-Vendor",
        chargePointModel: "CLI-Model",
      },
      timestamp: "2026-07-12T01:17:58.179Z",
      raw: SENT_BOOT,
    });
  });

  test("parses a Received CALLRESULT line", () => {
    const frame = parseLogLine(RECEIVED_BOOT_RESULT);
    expect(frame).toEqual({
      kind: "callresult",
      direction: "received",
      uniqueId: "102f1228-84cd-449e-9ccf-c1bcd4d5be7d",
      payload: {
        status: "Accepted",
        currentTime: "2026-07-12T01:17:58.182Z",
        interval: 14400,
      },
      timestamp: "2026-07-12T01:17:58.189Z",
      raw: RECEIVED_BOOT_RESULT,
    });
  });

  test("parses a CALLERROR line", () => {
    const frame = parseLogLine(CALLERROR_LINE);
    expect(frame).toEqual({
      kind: "callerror",
      direction: "received",
      uniqueId: "deadbeef-0000",
      errorCode: "NotSupported",
      errorDescription: "Action not supported",
      errorDetails: {},
      timestamp: "2026-07-12T01:19:00.000Z",
      raw: CALLERROR_LINE,
    });
  });

  test("returns null for non-frame log lines", () => {
    expect(parseLogLine(NON_FRAME_LOG_LINE)).toBeNull();
  });

  test("returns null for structured JSON event lines", () => {
    expect(parseLogLine(STRUCTURED_EVENT_LINE)).toBeNull();
  });

  test("returns null for JSON command-response lines", () => {
    expect(parseLogLine(COMMAND_RESPONSE_LINE)).toBeNull();
  });

  test("returns null for blank lines", () => {
    expect(parseLogLine("")).toBeNull();
    expect(parseLogLine("   ")).toBeNull();
  });

  test("returns null for a malformed frame array (no crash)", () => {
    const bad =
      '[2026-07-12T01:17:58.147Z] [INFO] [WebSocket] Sent: [2,"only-two-elements"]';
    expect(parseLogLine(bad)).toBeNull();
  });
});

describe("parseLog", () => {
  test("parses a whole multi-line log, skipping non-frame lines, preserving order", () => {
    const text = [
      NON_FRAME_LOG_LINE,
      SENT_BOOT,
      STRUCTURED_EVENT_LINE,
      RECEIVED_BOOT_RESULT,
      COMMAND_RESPONSE_LINE,
      RECEIVED_REMOTE_START,
      SENT_REMOTE_START_REJECTED,
      "",
    ].join("\n");

    const frames = parseLog(text);

    expect(frames).toHaveLength(4);
    expect(frames.map((f) => f.kind)).toEqual([
      "call",
      "callresult",
      "call",
      "callresult",
    ]);
  });
});

describe("findCall / findResponseFor (uniqueId correlation)", () => {
  test("pairs a CP-initiated request (sent CALL) with its received CALLRESULT", () => {
    const frames = parseLog([SENT_BOOT, RECEIVED_BOOT_RESULT].join("\n"));

    const call = findCall(frames, "sent", "BootNotification");
    expect(call).toBeDefined();
    const response = findResponseFor(frames, call as CallFrame);
    expect(response?.kind).toBe("callresult");
    expect(response?.uniqueId).toBe(call?.uniqueId);
    expect((response as { payload: { status: string } }).payload.status).toBe(
      "Accepted",
    );
  });

  test("pairs a CSMS-initiated request (received CALL) with its sent CALLRESULT, by uniqueId, NOT by log-window adjacency", () => {
    // Deliberately interleave unrelated frames between the request and its
    // response, with a DIFFERENT uniqueId placed directly adjacent to the
    // RemoteStartTransaction request -- a naive "next Sent: [3,...] after
    // this Received" windowed scan (the bash predecessor's approach) would
    // wrongly pick the interloper's CALLRESULT. uniqueId correlation must
    // not be fooled by this.
    const interloperUniqueId = "interloper-9999";
    const interloperSentStatusNotification = `[2026-07-12T01:18:03.474Z] [INFO] [WebSocket] Sent: [2,"${interloperUniqueId}","StatusNotification",{"connectorId":1,"errorCode":"NoError","status":"Available"}]`;
    const interloperReceivedResult = `[2026-07-12T01:18:03.475Z] [INFO] [WebSocket] Received: [3,"${interloperUniqueId}",{}]`;

    const frames = parseLog(
      [
        RECEIVED_REMOTE_START,
        interloperSentStatusNotification,
        interloperReceivedResult,
        SENT_REMOTE_START_REJECTED,
      ].join("\n"),
    );

    const call = findCall(frames, "received", "RemoteStartTransaction");
    expect(call).toBeDefined();
    const response = findResponseFor(frames, call as CallFrame);

    expect(response).toBeDefined();
    expect(response?.uniqueId).toBe("b22b934f-daa8-472d-94db-9f8cb3b16a10");
    expect(response?.uniqueId).not.toBe(interloperUniqueId);
    expect((response as { payload: { status: string } }).payload.status).toBe(
      "Rejected",
    );
  });

  test("findCall supports an occurrence index for repeated actions", () => {
    const first =
      '[2026-07-12T01:18:01.210Z] [INFO] [WebSocket] Sent: [2,"aaa","StatusNotification",{"connectorId":1,"status":"Available"}]';
    const second =
      '[2026-07-12T01:18:05.000Z] [INFO] [WebSocket] Sent: [2,"bbb","StatusNotification",{"connectorId":1,"status":"Preparing"}]';
    const frames = parseLog([first, second].join("\n"));

    expect(findCall(frames, "sent", "StatusNotification", 0)?.uniqueId).toBe(
      "aaa",
    );
    expect(findCall(frames, "sent", "StatusNotification", 1)?.uniqueId).toBe(
      "bbb",
    );
    expect(findCall(frames, "sent", "StatusNotification", 2)).toBeUndefined();
  });

  test("findResponseFor returns undefined when no response exists for that uniqueId", () => {
    const frames = parseLog(RECEIVED_REMOTE_START);
    const call = findCall(frames, "received", "RemoteStartTransaction");
    expect(findResponseFor(frames, call as CallFrame)).toBeUndefined();
  });

  test("findResponseFor does not match a response in the SAME direction as the request", () => {
    // A response to a received CALL must be sent (the reply direction), not
    // another received frame that happens to share a uniqueId by accident.
    const sameDirectionNoise =
      '[2026-07-12T01:18:03.474Z] [INFO] [WebSocket] Received: [3,"b22b934f-daa8-472d-94db-9f8cb3b16a10",{"status":"SpoofedNotAResponse"}]';
    const frames = parseLog(
      [RECEIVED_REMOTE_START, sameDirectionNoise].join("\n"),
    );
    const call = findCall(frames, "received", "RemoteStartTransaction");
    expect(findResponseFor(frames, call as CallFrame)).toBeUndefined();
  });
});
