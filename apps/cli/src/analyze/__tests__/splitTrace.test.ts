import { describe, expect, it } from "vitest";
import { assertRecord } from "@open-ocpp-trace/core";
import {
  recordsToJsonl,
  splitTraceRecords,
  type TraceSplit,
  type TraceSplitMode,
} from "../splitTrace";

/** Envelope fields the Open OCPP Trace format requires (#886). A fixture
 *  that only cares about routing gets them by default; `assertRecord`
 *  makes an incomplete fixture fail where it is built instead of reading
 *  as an `invalidRecord` exclusion. */
const ENVELOPE_DEFAULTS = {
  schemaVersion: "1.1",
  timestamp: "2026-01-01T00:00:00.000Z",
  transport: "json",
  direction: "cp-to-csms",
};

function line(rec: Record<string, unknown>): string {
  return JSON.stringify(assertRecord({ ...ENVELOPE_DEFAULTS, ...rec }));
}

/** The split with each group re-serialized as JSONL text, so routing
 *  assertions read the same lines the toolkit is handed. */
interface TextSplit extends Omit<TraceSplit, "byChargePoint" | "unattributed"> {
  byChargePoint: Map<string, string>;
  unattributed: string;
}

async function splitText(
  text: string,
  splitBy?: TraceSplitMode,
): Promise<TextSplit> {
  const split = await splitTraceRecords([text], splitBy);
  return {
    ...split,
    byChargePoint: new Map(
      Array.from(split.byChargePoint, ([id, records]) => [
        id,
        recordsToJsonl(records),
      ]),
    ),
    unattributed: recordsToJsonl(split.unattributed),
  };
}

const NO_EXCLUSIONS = {
  soap: 0,
  unsupportedOcppVersion: 0,
  unparseableLine: 0,
  invalidRecord: 0,
};

describe("splitTraceRecords: reading the JSONL stream (#886)", () => {
  const heartbeat = line({
    ocppVersion: "1.6",
    chargePointId: "CP-A",
    messageType: "CALL",
    messageId: "1",
    action: "Heartbeat",
    payload: {},
  });

  it("keeps a record that follows a UTF-8 BOM at the start of the stream", async () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(heartbeat + "\n", "utf8"),
    ]);

    const split = await splitTraceRecords([bytes]);

    expect(split.byChargePoint.get("CP-A")).toEqual([JSON.parse(heartbeat)]);
    expect(split.excluded).toEqual(NO_EXCLUSIONS);
    expect(split.total).toBe(1);
  });

  it("keeps records separated by CRLF line endings", async () => {
    const second = line({
      ocppVersion: "1.6",
      chargePointId: "CP-A",
      direction: "csms-to-cp",
      messageType: "CALLRESULT",
      messageId: "1",
      payload: { currentTime: "2026-01-01T00:00:01.000Z" },
    });

    const split = await splitTraceRecords([
      Buffer.from(`${heartbeat}\r\n${second}\r\n`, "utf8"),
    ]);

    expect(split.byChargePoint.get("CP-A")).toEqual([
      JSON.parse(heartbeat),
      JSON.parse(second),
    ]);
    expect(split.excluded).toEqual(NO_EXCLUSIONS);
    expect(split.total).toBe(2);
  });

  it("counts a JSON record missing its timestamp as an invalid record", async () => {
    const { timestamp: _omitted, ...noTimestamp } = JSON.parse(heartbeat);

    const split = await splitTraceRecords([
      [heartbeat, JSON.stringify(noTimestamp)].join("\n") + "\n",
    ]);

    expect(split.byChargePoint.get("CP-A")).toEqual([JSON.parse(heartbeat)]);
    expect(split.excluded).toEqual({ ...NO_EXCLUSIONS, invalidRecord: 1 });
    expect(split.total).toBe(2);
  });

  it("counts a record of an unsupported schema major version as an invalid record", async () => {
    const v2 = JSON.stringify({
      ...JSON.parse(heartbeat),
      schemaVersion: "2.0",
    });

    const split = await splitTraceRecords([[heartbeat, v2].join("\n") + "\n"]);

    expect(split.byChargePoint.get("CP-A")).toEqual([JSON.parse(heartbeat)]);
    expect(split.excluded).toEqual({ ...NO_EXCLUSIONS, invalidRecord: 1 });
    expect(split.total).toBe(2);
  });

  it("counts a line over 1 MiB as an invalid record and keeps reading after it", async () => {
    const huge = JSON.stringify({
      ...JSON.parse(heartbeat),
      messageId: "huge",
      payload: { blob: "x".repeat(1024 * 1024) },
    });

    const split = await splitTraceRecords([
      [huge, heartbeat].join("\n") + "\n",
    ]);

    expect(split.byChargePoint.get("CP-A")).toEqual([JSON.parse(heartbeat)]);
    expect(split.excluded).toEqual({ ...NO_EXCLUSIONS, invalidRecord: 1 });
    expect(split.total).toBe(2);
  });

  it("counts a line that is not valid UTF-8 as an invalid record", async () => {
    const bytes = Buffer.concat([
      Buffer.from([0x7b, 0xff, 0x7d, 0x0a]),
      Buffer.from(heartbeat + "\n", "utf8"),
    ]);

    const split = await splitTraceRecords([bytes]);

    expect(split.byChargePoint.get("CP-A")).toEqual([JSON.parse(heartbeat)]);
    expect(split.excluded).toEqual({ ...NO_EXCLUSIONS, invalidRecord: 1 });
    expect(split.total).toBe(2);
  });

  it("counts a line that is not JSON as an unparseable line", async () => {
    const split = await splitTraceRecords([
      [heartbeat, "this is not json"].join("\n") + "\n",
    ]);

    expect(split.byChargePoint.get("CP-A")).toEqual([JSON.parse(heartbeat)]);
    expect(split.excluded).toEqual({ ...NO_EXCLUSIONS, unparseableLine: 1 });
    expect(split.total).toBe(2);
  });

  it("counts a JSON array line as an invalid record, not an unparseable line", async () => {
    const split = await splitTraceRecords([
      [heartbeat, "[1,2,3]"].join("\n") + "\n",
    ]);

    expect(split.byChargePoint.get("CP-A")).toEqual([JSON.parse(heartbeat)]);
    expect(split.excluded).toEqual({ ...NO_EXCLUSIONS, invalidRecord: 1 });
    expect(split.total).toBe(2);
  });
});

describe("splitTraceRecords", () => {
  it("groups records by chargePointId, preserving line order within a group", async () => {
    const a1 = line({
      schemaVersion: "1.1",
      timestamp: "2026-01-01T00:00:00.000Z",
      ocppVersion: "1.6",
      transport: "json",
      chargePointId: "CP-A",
      direction: "cp-to-csms",
      messageType: "CALL",
      messageId: "1",
      action: "BootNotification",
    });
    const b1 = line({
      schemaVersion: "1.1",
      timestamp: "2026-01-01T00:00:01.000Z",
      ocppVersion: "1.6",
      transport: "json",
      chargePointId: "CP-B",
      direction: "cp-to-csms",
      messageType: "CALL",
      messageId: "1",
      action: "BootNotification",
    });
    const a2 = line({
      schemaVersion: "1.1",
      timestamp: "2026-01-01T00:00:02.000Z",
      ocppVersion: "1.6",
      transport: "json",
      chargePointId: "CP-A",
      direction: "csms-to-cp",
      messageType: "CALLRESULT",
      messageId: "1",
    });

    const split = await splitText([a1, b1, a2].join("\n") + "\n");

    expect(Array.from(split.byChargePoint.keys())).toEqual(["CP-A", "CP-B"]);
    expect(split.byChargePoint.get("CP-A")).toBe(a1 + "\n" + a2 + "\n");
    expect(split.byChargePoint.get("CP-B")).toBe(b1 + "\n");
    expect(split.unattributed).toBe("");
    expect(split.excluded).toEqual(NO_EXCLUSIONS);
    expect(split.total).toBe(3);
  });

  it("excludes soap-transport records and counts them", async () => {
    const kept = line({
      ocppVersion: "1.6",
      transport: "json",
      chargePointId: "CP-A",
      messageType: "CALL",
      messageId: "1",
      action: "Heartbeat",
    });
    const soap = line({
      ocppVersion: "1.6",
      transport: "soap",
      chargePointId: "CP-A",
      messageType: "CALL",
      messageId: "2",
      action: "Heartbeat",
    });

    const split = await splitText([kept, soap].join("\n") + "\n");

    expect(split.byChargePoint.get("CP-A")).toBe(kept + "\n");
    expect(split.excluded.soap).toBe(1);
    expect(split.total).toBe(2);
  });

  it("excludes records whose ocppVersion does not start with 1.6, but keeps records with no ocppVersion at all", async () => {
    const v16 = line({
      ocppVersion: "1.6",
      transport: "json",
      chargePointId: "CP-A",
      messageType: "CALL",
      messageId: "1",
      action: "Heartbeat",
    });
    const v201 = line({
      ocppVersion: "2.0.1",
      transport: "json",
      chargePointId: "CP-A",
      messageType: "CALL",
      messageId: "2",
      action: "Heartbeat",
    });
    const v21 = line({
      ocppVersion: "2.1",
      transport: "json",
      chargePointId: "CP-A",
      messageType: "CALL",
      messageId: "3",
      action: "Heartbeat",
    });
    const noVersion = line({
      transport: "json",
      chargePointId: "CP-A",
      messageType: "CALL",
      messageId: "4",
      action: "Heartbeat",
    });

    const split = await splitText(
      [v16, v201, v21, noVersion].join("\n") + "\n",
    );

    expect(split.byChargePoint.get("CP-A")).toBe(v16 + "\n" + noVersion + "\n");
    expect(split.excluded.unsupportedOcppVersion).toBe(2);
    expect(split.total).toBe(4);
  });

  it("counts unparseable lines and skips them without throwing", async () => {
    const good = line({
      ocppVersion: "1.6",
      transport: "json",
      chargePointId: "CP-A",
      messageType: "CALL",
      messageId: "1",
      action: "Heartbeat",
    });
    const notJson = "this is not json";
    // Valid JSON, but not an object: since #886 the SDK reader reports it
    // as a validation error, so it counts as an invalid record.
    const jsonArray = "[1,2,3]";

    const split = await splitText([good, notJson, jsonArray].join("\n") + "\n");

    expect(split.byChargePoint.get("CP-A")).toBe(good + "\n");
    expect(split.excluded.unparseableLine).toBe(1);
    expect(split.excluded.invalidRecord).toBe(1);
    expect(split.total).toBe(3);
  });

  it("buckets records with no chargePointId into `unattributed`", async () => {
    const withCp = line({
      ocppVersion: "1.6",
      transport: "json",
      chargePointId: "CP-A",
      messageType: "CALL",
      messageId: "1",
      action: "Heartbeat",
    });
    const withoutCp = line({
      ocppVersion: "1.6",
      transport: "json",
      messageType: "CALL",
      messageId: "2",
      action: "Heartbeat",
    });

    const split = await splitText([withCp, withoutCp].join("\n") + "\n");

    expect(split.byChargePoint.get("CP-A")).toBe(withCp + "\n");
    expect(split.unattributed).toBe(withoutCp + "\n");
    expect(split.total).toBe(2);
  });

  it("returns empty structures for empty input", async () => {
    const split = await splitText("");

    expect(split.byChargePoint.size).toBe(0);
    expect(split.unattributed).toBe("");
    expect(split.excluded).toEqual(NO_EXCLUSIONS);
    expect(split.total).toBe(0);
  });

  it("holds the parsed records, re-serialized semantically equal but not byte-identical to the input line (#886)", async () => {
    // Deliberately odd formatting (extra whitespace) that serializeRecord
    // normalizes away; key order and every value, `raw` included, survive.
    const raw =
      '{"schemaVersion": "1.1", "timestamp":"2026-01-01T00:00:00.000Z", "ocppVersion":  "1.6", "transport": "json", "chargePointId":"CP-A", "direction": "cp-to-csms", "messageType":"CALL", "messageId":"1",   "action": "Heartbeat", "raw": "[2, \\"1\\", \\"Heartbeat\\", {}]"}';

    const records = await splitTraceRecords([raw + "\n"]);
    const text = await splitText(raw + "\n");

    expect(records.byChargePoint.get("CP-A")).toEqual([JSON.parse(raw)]);
    expect(text.byChargePoint.get("CP-A")).toBe(
      JSON.stringify(JSON.parse(raw)) + "\n",
    );
    expect(text.byChargePoint.get("CP-A")).not.toBe(raw + "\n");
  });

  it("defaults to splitBy 'charge-point' -- an explicit 'charge-point' produces byte-identical output to the implicit default", async () => {
    const a1 = line({
      ocppVersion: "1.6",
      transport: "json",
      chargePointId: "CP-A",
      messageType: "CALL",
      messageId: "1",
      action: "Heartbeat",
    });
    const jsonl = a1 + "\n";

    const implicit = await splitText(jsonl);
    const explicit = await splitText(jsonl, "charge-point");

    expect(explicit.byChargePoint.get("CP-A")).toBe(
      implicit.byChargePoint.get("CP-A"),
    );
    expect(Array.from(explicit.byChargePoint.keys())).toEqual(
      Array.from(implicit.byChargePoint.keys()),
    );
  });
});

describe("splitTraceRecords (splitBy: 'connector')", () => {
  /** Builds one CP-A connector-scoped session (Start/MeterValues/Stop) whose
   *  StartTransaction messageId, transactionId and connectorId are all
   *  distinct per call, so cross-connector mixups would be caught. */
  function session(
    connectorId: number,
    startMsgId: string,
    transactionId: number,
    stopMsgId: string,
  ): string[] {
    return [
      line({
        ocppVersion: "1.6",
        transport: "json",
        chargePointId: "CP-A",
        connectorId,
        direction: "cp-to-csms",
        messageType: "CALL",
        messageId: startMsgId,
        action: "StartTransaction",
        payload: { connectorId, idTag: `TAG-${connectorId}`, meterStart: 0 },
      }),
      line({
        ocppVersion: "1.6",
        transport: "json",
        chargePointId: "CP-A",
        direction: "csms-to-cp",
        messageType: "CALLRESULT",
        messageId: startMsgId,
        payload: { idTagInfo: { status: "Accepted" }, transactionId },
      }),
      line({
        ocppVersion: "1.6",
        transport: "json",
        chargePointId: "CP-A",
        connectorId,
        direction: "cp-to-csms",
        messageType: "CALL",
        messageId: `${startMsgId}-mv`,
        action: "MeterValues",
        payload: {
          connectorId,
          transactionId,
          meterValue: [{ sampledValue: [{ value: "100" }] }],
        },
      }),
      line({
        ocppVersion: "1.6",
        transport: "json",
        chargePointId: "CP-A",
        direction: "cp-to-csms",
        messageType: "CALL",
        messageId: stopMsgId,
        action: "StopTransaction",
        payload: { transactionId, meterStop: 100, reason: "Local" },
      }),
      line({
        ocppVersion: "1.6",
        transport: "json",
        chargePointId: "CP-A",
        direction: "csms-to-cp",
        messageType: "CALLRESULT",
        messageId: stopMsgId,
        payload: {},
      }),
    ];
  }

  it("groups a station's own-connectorId-carrying records (StatusNotification/MeterValues/StartTransaction) by connectorId, keyed '<cpId>-connector<N>'", async () => {
    const lines = [
      ...session(1, "s1", 1001, "e1"),
      ...session(2, "s2", 2002, "e2"),
    ];

    const split = await splitText(lines.join("\n") + "\n", "connector");

    expect(Array.from(split.byChargePoint.keys())).toEqual([
      "CP-A-connector1",
      "CP-A-connector2",
    ]);
    const conn1 = split.byChargePoint.get("CP-A-connector1") ?? "";
    const conn2 = split.byChargePoint.get("CP-A-connector2") ?? "";
    expect(conn1).toContain('"messageId":"s1"');
    expect(conn1).toContain('"messageId":"s1-mv"');
    expect(conn1).toContain('"messageId":"e1"');
    expect(conn1).not.toContain('"messageId":"s2"');
    expect(conn1).not.toContain('"messageId":"e2"');
    expect(conn2).toContain('"messageId":"s2"');
    expect(conn2).toContain('"messageId":"s2-mv"');
    expect(conn2).toContain('"messageId":"e2"');
    expect(conn2).not.toContain('"messageId":"s1"');
  });

  it("resolves StopTransaction's connector via StartTransaction messageId -> CALLRESULT transactionId -> StartTransaction connectorId correlation (StopTransaction itself carries only transactionId)", async () => {
    const lines = [
      ...session(1, "s1", 1001, "e1"),
      ...session(2, "s2", 2002, "e2"),
    ];

    const split = await splitText(lines.join("\n") + "\n", "connector");

    const conn1 = split.byChargePoint.get("CP-A-connector1") ?? "";
    const conn2 = split.byChargePoint.get("CP-A-connector2") ?? "";
    // The StopTransaction CALL for transaction 1001 (connector 1) lands only
    // in connector 1's group, not connector 2's, even though its own
    // payload has no connectorId field at all.
    expect(conn1).toContain('"messageId":"e1"');
    expect(conn1).toContain('"action":"StopTransaction"');
    expect(conn2).not.toContain('"messageId":"e1"');
  });

  it("routes a CALLRESULT to the same connector group as the CALL it answers (inherits by messageId), instead of treating every response as station-level", async () => {
    const lines = [
      ...session(1, "s1", 1001, "e1"),
      ...session(2, "s2", 2002, "e2"),
    ];

    const split = await splitText(lines.join("\n") + "\n", "connector");

    const conn1 = split.byChargePoint.get("CP-A-connector1") ?? "";
    const conn2 = split.byChargePoint.get("CP-A-connector2") ?? "";
    // StartTransaction's CALLRESULT (messageId "s1") carries the
    // transactionId used to resolve StopTransaction's connector, and must
    // itself only live in connector 1's group -- if it were replicated to
    // every group as "station-level", it would produce a phantom session in
    // connector 2's report too (a new false positive, the exact artifact
    // this feature exists to avoid).
    expect(conn1).toContain('"messageType":"CALLRESULT","messageId":"s1"');
    expect(conn2).not.toContain('"messageType":"CALLRESULT","messageId":"s1"');
  });

  it("replicates station-level records (no connector at all, e.g. BootNotification/Heartbeat) into every connector group", async () => {
    const boot = line({
      ocppVersion: "1.6",
      transport: "json",
      chargePointId: "CP-A",
      direction: "cp-to-csms",
      messageType: "CALL",
      messageId: "boot",
      action: "BootNotification",
      payload: {},
    });
    const lines = [
      boot,
      ...session(1, "s1", 1001, "e1"),
      ...session(2, "s2", 2002, "e2"),
    ];

    const split = await splitText(lines.join("\n") + "\n", "connector");

    expect(split.byChargePoint.get("CP-A-connector1")).toContain(
      '"messageId":"boot"',
    );
    expect(split.byChargePoint.get("CP-A-connector2")).toContain(
      '"messageId":"boot"',
    );
  });

  it("treats connectorId: 0 as station-level (not connector 1), replicated into every connector group", async () => {
    const stationStatus = line({
      ocppVersion: "1.6",
      transport: "json",
      chargePointId: "CP-A",
      connectorId: 0,
      direction: "cp-to-csms",
      messageType: "CALL",
      messageId: "st0",
      action: "StatusNotification",
      payload: { connectorId: 0, status: "Available", errorCode: "NoError" },
    });
    const lines = [
      stationStatus,
      ...session(1, "s1", 1001, "e1"),
      ...session(2, "s2", 2002, "e2"),
    ];

    const split = await splitText(lines.join("\n") + "\n", "connector");

    expect(split.byChargePoint.get("CP-A-connector1")).toContain(
      '"messageId":"st0"',
    );
    expect(split.byChargePoint.get("CP-A-connector2")).toContain(
      '"messageId":"st0"',
    );
  });

  it("falls back to one plain-cpId group (not connector-suffixed) when a charge point has no connector-scoped records at all, so nothing is silently dropped", async () => {
    const lines = [
      line({
        ocppVersion: "1.6",
        transport: "json",
        chargePointId: "CP-B",
        direction: "cp-to-csms",
        messageType: "CALL",
        messageId: "1",
        action: "Heartbeat",
        payload: {},
      }),
    ];

    const split = await splitText(lines.join("\n") + "\n", "connector");

    expect(Array.from(split.byChargePoint.keys())).toEqual(["CP-B"]);
    expect(split.byChargePoint.get("CP-B")).toContain('"action":"Heartbeat"');
  });

  it("keeps the split independent per charge point: CP-A's connector groups don't see CP-B's records", async () => {
    const cpBLine = line({
      ocppVersion: "1.6",
      transport: "json",
      chargePointId: "CP-B",
      connectorId: 1,
      direction: "cp-to-csms",
      messageType: "CALL",
      messageId: "b1",
      action: "StatusNotification",
      payload: { connectorId: 1, status: "Available", errorCode: "NoError" },
    });
    const lines = [...session(1, "s1", 1001, "e1"), cpBLine];

    const split = await splitText(lines.join("\n") + "\n", "connector");

    expect(Array.from(split.byChargePoint.keys())).toEqual([
      "CP-A-connector1",
      "CP-B-connector1",
    ]);
  });
});
