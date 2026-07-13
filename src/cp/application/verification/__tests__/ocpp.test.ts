import { describe, it, expect } from "vitest";
import { parseFrameMessage, parseLogLine } from "../ocpp";

describe("parseFrameMessage", () => {
  it("parses a Sent CALL message, raw defaulting to the message itself", () => {
    const frame = parseFrameMessage(
      'Sent: [2,"uid-1","BootNotification",{"chargePointVendor":"V"}]',
      "2026-07-13T00:00:00.000Z",
    );
    expect(frame).toEqual({
      kind: "call",
      direction: "sent",
      uniqueId: "uid-1",
      action: "BootNotification",
      payload: { chargePointVendor: "V" },
      timestamp: "2026-07-13T00:00:00.000Z",
      raw: 'Sent: [2,"uid-1","BootNotification",{"chargePointVendor":"V"}]',
    });
  });

  it("parses a Received CALLRESULT message", () => {
    const frame = parseFrameMessage(
      'Received: [3,"uid-1",{"status":"Accepted"}]',
      "2026-07-13T00:00:01.000Z",
    );
    expect(frame).toEqual({
      kind: "callresult",
      direction: "received",
      uniqueId: "uid-1",
      payload: { status: "Accepted" },
      timestamp: "2026-07-13T00:00:01.000Z",
      raw: 'Received: [3,"uid-1",{"status":"Accepted"}]',
    });
  });

  it("returns null for a non-frame message", () => {
    expect(
      parseFrameMessage("WebSocket connected successfully", "ts"),
    ).toBeNull();
  });

  it("accepts an explicit `raw` distinct from the parsed message", () => {
    // TranscriptBuffer's use case: it only has entry.message (the bare
    // "Sent:/Received: [...]" text, no log-line prefix), so `raw` there
    // equals `message`. But callers with the full formatted line (like
    // parseLogLine below) can pass a different `raw`.
    const frame = parseFrameMessage(
      'Sent: [2,"uid-2","Heartbeat",{}]',
      "ts",
      '[ts] [INFO] [WebSocket] Sent: [2,"uid-2","Heartbeat",{}]',
    );
    expect(frame?.raw).toBe(
      '[ts] [INFO] [WebSocket] Sent: [2,"uid-2","Heartbeat",{}]',
    );
  });

  it("parseLogLine delegates to parseFrameMessage with raw = the full line", () => {
    const line =
      '[2026-07-13T00:00:00.000Z] [INFO] [WebSocket] Sent: [2,"uid-3","Heartbeat",{}]';
    const viaLogLine = parseLogLine(line);
    const viaFrameMessage = parseFrameMessage(
      'Sent: [2,"uid-3","Heartbeat",{}]',
      "2026-07-13T00:00:00.000Z",
      line,
    );
    expect(viaLogLine).toEqual(viaFrameMessage);
    expect(viaLogLine?.raw).toBe(line);
  });
});
