import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "@open-ocpp-trace/core";
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
      schemaVersion: SCHEMA_VERSION,
      timestamp: "2026-07-14T02:00:00.000Z",
      transport: "json",
      ocppVersion: "1.6",
      chargePointId: "CP001",
      direction: "cp-to-csms",
      messageType: "CALL",
      messageId: "abc-1",
      action: "BootNotification",
      payload: { chargePointVendor: "Example" },
      raw: '[2,"abc-1","BootNotification",{"chargePointVendor":"Example"}]',
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

describe("trace format v1.1", () => {
  it("stamps records with schemaVersion 1.1", () => {
    expect(SCHEMA_VERSION).toBe("1.1");
  });

  it("carries the verbatim frame text in raw, preserving spacing and key order", () => {
    // Deliberately non-canonical JSON: spacing and key order must survive
    // byte-exactly (hashing/dedup on raw is a consumer use case).
    const frameText = '[2, "abc-1", "BootNotification", {"b": 1, "a": 2} ]';
    const record = logLineToTraceRecord(line(`Sent: ${frameText}`));
    expect(record?.raw).toBe(frameText);
  });

  it("round-trips a well-formed frame through JSON.parse(raw)", () => {
    const record = logLineToTraceRecord(
      line('Received: [4,"m-9","NotSupported","Boom",{"x":1}]'),
    );
    expect(JSON.parse(record?.raw ?? "")).toEqual([
      4,
      "m-9",
      "NotSupported",
      "Boom",
      { x: 1 },
    ]);
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

  it("emits raw on every record in a batch", () => {
    const records = logLinesToTrace([
      line('Sent: [2,"m-1","Heartbeat",{}]'),
      line('Received: [3,"m-1",{}]'),
    ]);
    expect(records.map((r) => r.raw)).toEqual([
      '[2,"m-1","Heartbeat",{}]',
      '[3,"m-1",{}]',
    ]);
  });

  it("scopes correlation per charge point when a batch reuses a messageId", () => {
    // Two CPs both use messageId "1"; each CALLRESULT must inherit its own CP's
    // action, not the other's.
    const records = logLinesToTrace([
      line('Sent: [2,"1","BootNotification",{}]', { cpId: "CP-A" }),
      line('Sent: [2,"1","Heartbeat",{}]', { cpId: "CP-B" }),
      line('Received: [3,"1",{"status":"Accepted"}]', { cpId: "CP-A" }),
      line('Received: [3,"1",{}]', { cpId: "CP-B" }),
    ]);

    const resultA = records.find(
      (r) => r.chargePointId === "CP-A" && r.messageType === "CALLRESULT",
    );
    const resultB = records.find(
      (r) => r.chargePointId === "CP-B" && r.messageType === "CALLRESULT",
    );
    expect(resultA?.action).toBe("BootNotification");
    expect(resultB?.action).toBe("Heartbeat");
  });
});

describe("inbound validation violations (#593)", () => {
  it("merges the violation into the inbound CALL record's meta", () => {
    const records = logLinesToTrace([
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        message: 'Received: [2,"v-1","Reset",{"type":"Warm"}]',
        cpId: "CP1",
      },
      {
        timestamp: "2026-01-01T00:00:00.001Z",
        message: `Inbound validation: ${JSON.stringify({
          messageId: "v-1",
          action: "Reset",
          mode: "enforce",
          errorCode: "PropertyConstraintViolation",
          description: "bad enum",
        })}`,
        cpId: "CP1",
      },
      {
        timestamp: "2026-01-01T00:00:00.002Z",
        message: 'Sent: [4,"v-1","PropertyConstraintViolation","bad enum",{}]',
        cpId: "CP1",
      },
    ]);
    expect(records).toHaveLength(2);
    expect(records[0].meta).toEqual({
      validation: {
        mode: "enforce",
        errorCode: "PropertyConstraintViolation",
        description: "bad enum",
      },
    });
    expect(records[1].meta).toBeUndefined();
  });
});

// Key order is visible in every JSONL line the trace writers produce, so the
// move to the SDK's discriminated TraceRecord (#886) must not reorder it.
describe("record key order", () => {
  const ctx = { ocppVersion: "1.6" };
  it.each([
    [
      'Sent: [2,"k-1","Heartbeat",{}]',
      "schemaVersion timestamp transport direction messageType ocppVersion chargePointId messageId action payload raw",
    ],
    [
      'Received: [3,"k-1",{}]',
      "schemaVersion timestamp transport direction messageType ocppVersion chargePointId messageId payload raw",
    ],
    [
      'Received: [4,"k-1","NotImplemented","",{}]',
      "schemaVersion timestamp transport direction messageType ocppVersion chargePointId messageId error raw",
    ],
  ])("%s", (message, keys) => {
    const record = logLineToTraceRecord(line(message, { cpId: "CP1" }), ctx);
    expect(Object.keys(record ?? {}).join(" ")).toBe(keys);
  });
});

describe("connectorId (#999)", () => {
  const ctx16 = { ocppVersion: "1.6" };
  const ctx201 = { ocppVersion: "2.0.1" };
  const call = (action: string, payload: unknown) =>
    `Sent: [2,"c-1","${action}",${JSON.stringify(payload)}]`;

  it.each([
    ["StatusNotification", { connectorId: 2, status: "Available" }, 2],
    ["MeterValues", { connectorId: 1, meterValue: [] }, 1],
    ["StartTransaction", { connectorId: 3, idTag: "T" }, 3],
    ["RemoteStartTransaction", { connectorId: 1, idTag: "T" }, 1],
    ["UnlockConnector", { connectorId: 2 }, 2],
    ["ChangeAvailability", { connectorId: 0, type: "Inoperative" }, 0],
    ["TriggerMessage", { requestedMessage: "MeterValues", connectorId: 4 }, 4],
  ])("stamps a 1.6 %s CALL's payload.connectorId", (action, payload, id) => {
    const record = logLineToTraceRecord(line(call(action, payload)), ctx16);
    expect(record?.connectorId).toBe(id);
  });

  it.each([
    [
      "StatusNotification",
      { evseId: 1, connectorId: 2, connectorStatus: "Available" },
      2,
    ],
    ["UnlockConnector", { evseId: 1, connectorId: 1 }, 1],
    [
      "TransactionEvent",
      { eventType: "Started", evse: { id: 1, connectorId: 2 } },
      2,
    ],
    [
      "ChangeAvailability",
      { operationalStatus: "Inoperative", evse: { id: 2, connectorId: 1 } },
      1,
    ],
    [
      "TriggerMessage",
      {
        requestedMessage: "StatusNotification",
        evse: { id: 1, connectorId: 0 },
      },
      0,
    ],
  ])("stamps a 2.x %s CALL's connector", (action, payload, id) => {
    const record = logLineToTraceRecord(line(call(action, payload)), ctx201);
    expect(record?.connectorId).toBe(id);
  });

  it.each([
    ["BootNotification", { chargePointVendor: "V" }],
    ["StopTransaction", { transactionId: 7 }],
    ["StatusNotification", { connectorId: -1 }],
    ["StatusNotification", { connectorId: 1.5 }],
    ["StatusNotification", { connectorId: "1" }],
    ["StatusNotification", { connectorId: null }],
    ["TransactionEvent", { evse: { id: 1 } }],
    ["TransactionEvent", { evse: [{ connectorId: 1 }] }],
    ["TransactionEvent", { evse: { id: 1, connectorId: -2 } }],
    ["RequestStartTransaction", { evseId: 1, idToken: {} }],
    [
      "GetVariables",
      {
        getVariableData: [{ component: { evse: { id: 1, connectorId: 1 } } }],
      },
    ],
  ])("leaves %s %j without connectorId", (action, payload) => {
    const record = logLineToTraceRecord(line(call(action, payload)), ctx16);
    expect(record).not.toHaveProperty("connectorId");
  });

  it("leaves a CALL with no payload object without connectorId", () => {
    const record = logLineToTraceRecord(line('Sent: [2,"c-1","Heartbeat"]'));
    expect(record).not.toHaveProperty("connectorId");
  });

  it("does not stamp a response from its own payload", () => {
    const record = logLineToTraceRecord(
      line('Received: [3,"c-1",{"status":"Accepted","connectorId":1}]'),
      ctx16,
    );
    expect(record).not.toHaveProperty("connectorId");
  });

  it("puts connectorId right after chargePointId", () => {
    const record = logLineToTraceRecord(
      line(call("StatusNotification", { connectorId: 1 }), { cpId: "CP1" }),
      ctx16,
    );
    expect(Object.keys(record ?? {}).join(" ")).toBe(
      "schemaVersion timestamp transport direction messageType ocppVersion chargePointId connectorId messageId action payload raw",
    );
  });

  it("back-fills responses and StopTransaction through the batch correlation, per charge point", () => {
    const at = (message: string, cpId: string) => line(message, { cpId });
    const records = logLinesToTrace(
      [
        at('Sent: [2,"s-1","StartTransaction",{"connectorId":2}]', "A"),
        at('Sent: [2,"s-1","StartTransaction",{"connectorId":1}]', "B"),
        at('Received: [3,"s-1",{"transactionId":7}]', "A"),
        at('Received: [3,"s-1",{"transactionId":7}]', "B"),
        at(
          'Received: [2,"r-1","RemoteStopTransaction",{"transactionId":7}]',
          "A",
        ),
        at('Sent: [3,"r-1",{"status":"Accepted"}]', "A"),
        at('Sent: [2,"t-1","StopTransaction",{"transactionId":7}]', "B"),
        at('Received: [4,"t-1","InternalError","",{}]', "B"),
        at('Sent: [2,"h-1","Heartbeat",{}]', "A"),
        at('Received: [3,"h-1",{}]', "A"),
      ],
      ctx16,
    );
    expect(records.map((r) => r.connectorId)).toEqual([
      2,
      1,
      2,
      1,
      2,
      2,
      1,
      1,
      undefined,
      undefined,
    ]);
    expect(records[9]).not.toHaveProperty("connectorId");
    // Back-filled connectorId keeps its slot after chargePointId; the
    // back-filled action stays last, as before #999.
    expect(JSON.stringify(records[2])).toBe(
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        timestamp: "2026-07-14T02:00:00.000Z",
        transport: "json",
        direction: "csms-to-cp",
        messageType: "CALLRESULT",
        ocppVersion: "1.6",
        chargePointId: "A",
        connectorId: 2,
        messageId: "s-1",
        payload: { transactionId: 7 },
        raw: '[3,"s-1",{"transactionId":7}]',
        action: "StartTransaction",
      }),
    );
  });
});
