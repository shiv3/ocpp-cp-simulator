import { describe, expect, it } from "vitest";
import { OCPP_TRACE_SCHEMA_VERSION } from "../OcppTraceRecord";
import {
  logLineToTraceRecord,
  logLinesToTrace,
  type SerializedLogLine,
} from "../logEntryToTrace";

function line(
  message: string,
  extra: Partial<SerializedLogLine> = {},
): SerializedLogLine {
  return {
    timestamp: "2026-07-14T02:00:00.000Z",
    level: "INFO",
    type: "WebSocket",
    message,
    ...extra,
  };
}

describe("logLineToTraceRecord", () => {
  it("maps a sent CALL frame to a cp-to-csms record with action and payload", () => {
    const record = logLineToTraceRecord(
      line(
        'Sent: [2,"abc-1","BootNotification",{"chargePointVendor":"Example"}]',
        { cpId: "CP001" },
      ),
      { ocppVersion: "1.6" },
    );

    expect(record).toEqual({
      schemaVersion: OCPP_TRACE_SCHEMA_VERSION,
      timestamp: "2026-07-14T02:00:00.000Z",
      transport: "json",
      ocppVersion: "1.6",
      chargePointId: "CP001",
      direction: "cp-to-csms",
      messageType: "CALL",
      messageId: "abc-1",
      action: "BootNotification",
      payload: { chargePointVendor: "Example" },
    });
  });

  it("maps a received CALLRESULT frame to a csms-to-cp record (no action on its own)", () => {
    const record = logLineToTraceRecord(
      line('Received: [3,"abc-1",{"status":"Accepted"}]'),
    );
    expect(record).toMatchObject({
      direction: "csms-to-cp",
      messageType: "CALLRESULT",
      messageId: "abc-1",
      payload: { status: "Accepted" },
    });
    expect(record?.action).toBeUndefined();
  });

  it("maps a CALLERROR frame into the error field", () => {
    const record = logLineToTraceRecord(
      line('Received: [4,"abc-2","NotSupported","Boom",{"x":1}]'),
    );
    expect(record).toMatchObject({
      messageType: "CALLERROR",
      messageId: "abc-2",
      error: { code: "NotSupported", description: "Boom", details: { x: 1 } },
    });
  });

  it("returns null for a non-wire log line", () => {
    expect(logLineToTraceRecord(line("Boot notification accepted"))).toBeNull();
    expect(
      logLineToTraceRecord(line("Suppressing StatusNotification: boot gate")),
    ).toBeNull();
  });

  it("prefers the line's cpId over the context fallback", () => {
    const record = logLineToTraceRecord(
      line('Sent: [2,"id","Heartbeat",{}]', { cpId: "CP-LINE" }),
      { chargePointId: "CP-CTX" },
    );
    expect(record?.chargePointId).toBe("CP-LINE");
  });

  it("falls back to the context chargePointId when the line has none", () => {
    const record = logLineToTraceRecord(line('Sent: [2,"id","Heartbeat",{}]'), {
      chargePointId: "CP-CTX",
    });
    expect(record?.chargePointId).toBe("CP-CTX");
  });
});

describe("logLinesToTrace", () => {
  it("drops non-wire lines and back-fills CALLRESULT action by messageId", () => {
    const records = logLinesToTrace([
      line("Boot notification accepted"),
      line('Sent: [2,"m-1","BootNotification",{"chargePointVendor":"V"}]', {
        cpId: "CP001",
      }),
      line("Some diagnostic chatter"),
      line('Received: [3,"m-1",{"status":"Accepted"}]', { cpId: "CP001" }),
    ]);

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      messageType: "CALL",
      action: "BootNotification",
      direction: "cp-to-csms",
    });
    // The CALLRESULT inherits the action from the correlated CALL.
    expect(records[1]).toMatchObject({
      messageType: "CALLRESULT",
      messageId: "m-1",
      action: "BootNotification",
      direction: "csms-to-cp",
    });
  });

  it("leaves an uncorrelated CALLRESULT action undefined", () => {
    const records = logLinesToTrace([
      line('Received: [3,"orphan",{"status":"Accepted"}]'),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0].action).toBeUndefined();
  });
});
