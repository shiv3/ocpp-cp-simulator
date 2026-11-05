import { describe, expect, it } from "vitest";
import { splitTraceJsonl } from "../splitTrace";

function line(rec: Record<string, unknown>): string {
  return JSON.stringify(rec);
}

describe("splitTraceJsonl", () => {
  it("groups records by chargePointId, preserving line order within a group", () => {
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

    const split = splitTraceJsonl([a1, b1, a2].join("\n") + "\n");

    expect(Array.from(split.byChargePoint.keys())).toEqual(["CP-A", "CP-B"]);
    expect(split.byChargePoint.get("CP-A")).toBe(a1 + "\n" + a2 + "\n");
    expect(split.byChargePoint.get("CP-B")).toBe(b1 + "\n");
    expect(split.unattributed).toBe("");
    expect(split.excluded).toEqual({
      soap: 0,
      unsupportedOcppVersion: 0,
      unparseableLine: 0,
    });
    expect(split.total).toBe(3);
  });

  it("excludes soap-transport records and counts them", () => {
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

    const split = splitTraceJsonl([kept, soap].join("\n") + "\n");

    expect(split.byChargePoint.get("CP-A")).toBe(kept + "\n");
    expect(split.excluded.soap).toBe(1);
    expect(split.total).toBe(2);
  });

  it("excludes records whose ocppVersion does not start with 1.6, but keeps records with no ocppVersion at all", () => {
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

    const split = splitTraceJsonl(
      [v16, v201, v21, noVersion].join("\n") + "\n",
    );

    expect(split.byChargePoint.get("CP-A")).toBe(v16 + "\n" + noVersion + "\n");
    expect(split.excluded.unsupportedOcppVersion).toBe(2);
    expect(split.total).toBe(4);
  });

  it("counts unparseable lines and skips them without throwing", () => {
    const good = line({
      ocppVersion: "1.6",
      transport: "json",
      chargePointId: "CP-A",
      messageType: "CALL",
      messageId: "1",
      action: "Heartbeat",
    });
    const notJson = "this is not json";
    const jsonArray = "[1,2,3]"; // valid JSON, but not an object -> unparseable

    const split = splitTraceJsonl([good, notJson, jsonArray].join("\n") + "\n");

    expect(split.byChargePoint.get("CP-A")).toBe(good + "\n");
    expect(split.excluded.unparseableLine).toBe(2);
    expect(split.total).toBe(3);
  });

  it("buckets records with no chargePointId into `unattributed`", () => {
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

    const split = splitTraceJsonl([withCp, withoutCp].join("\n") + "\n");

    expect(split.byChargePoint.get("CP-A")).toBe(withCp + "\n");
    expect(split.unattributed).toBe(withoutCp + "\n");
    expect(split.total).toBe(2);
  });

  it("returns empty structures for empty input", () => {
    const split = splitTraceJsonl("");

    expect(split.byChargePoint.size).toBe(0);
    expect(split.unattributed).toBe("");
    expect(split.excluded).toEqual({
      soap: 0,
      unsupportedOcppVersion: 0,
      unparseableLine: 0,
    });
    expect(split.total).toBe(0);
  });

  it("preserves the original raw line text verbatim (byte fidelity), not a re-stringified copy", () => {
    // Deliberately odd formatting (extra whitespace, key order) that
    // JSON.stringify would normalize away if we round-tripped through parse.
    const raw =
      '{"ocppVersion":  "1.6", "transport": "json", "chargePointId":"CP-A", "messageType":"CALL", "messageId":"1",   "action": "Heartbeat"}';

    const split = splitTraceJsonl(raw + "\n");

    expect(split.byChargePoint.get("CP-A")).toBe(raw + "\n");
  });

  it("defaults to splitBy 'charge-point' -- an explicit 'charge-point' produces byte-identical output to the implicit default", () => {
    const a1 = line({
      ocppVersion: "1.6",
      transport: "json",
      chargePointId: "CP-A",
      messageType: "CALL",
      messageId: "1",
      action: "Heartbeat",
    });
    const jsonl = a1 + "\n";

    const implicit = splitTraceJsonl(jsonl);
    const explicit = splitTraceJsonl(jsonl, "charge-point");

    expect(explicit.byChargePoint.get("CP-A")).toBe(
      implicit.byChargePoint.get("CP-A"),
    );
    expect(Array.from(explicit.byChargePoint.keys())).toEqual(
      Array.from(implicit.byChargePoint.keys()),
    );
  });
});

describe("splitTraceJsonl (splitBy: 'connector')", () => {
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

  it("groups a station's own-connectorId-carrying records (StatusNotification/MeterValues/StartTransaction) by connectorId, keyed '<cpId>-connector<N>'", () => {
    const lines = [
      ...session(1, "s1", 1001, "e1"),
      ...session(2, "s2", 2002, "e2"),
    ];

    const split = splitTraceJsonl(lines.join("\n") + "\n", "connector");

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

  it("resolves StopTransaction's connector via StartTransaction messageId -> CALLRESULT transactionId -> StartTransaction connectorId correlation (StopTransaction itself carries only transactionId)", () => {
    const lines = [
      ...session(1, "s1", 1001, "e1"),
      ...session(2, "s2", 2002, "e2"),
    ];

    const split = splitTraceJsonl(lines.join("\n") + "\n", "connector");

    const conn1 = split.byChargePoint.get("CP-A-connector1") ?? "";
    const conn2 = split.byChargePoint.get("CP-A-connector2") ?? "";
    // The StopTransaction CALL for transaction 1001 (connector 1) lands only
    // in connector 1's group, not connector 2's, even though its own
    // payload has no connectorId field at all.
    expect(conn1).toContain('"messageId":"e1"');
    expect(conn1).toContain('"action":"StopTransaction"');
    expect(conn2).not.toContain('"messageId":"e1"');
  });

  it("routes a CALLRESULT to the same connector group as the CALL it answers (inherits by messageId), instead of treating every response as station-level", () => {
    const lines = [
      ...session(1, "s1", 1001, "e1"),
      ...session(2, "s2", 2002, "e2"),
    ];

    const split = splitTraceJsonl(lines.join("\n") + "\n", "connector");

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

  it("replicates station-level records (no connector at all, e.g. BootNotification/Heartbeat) into every connector group", () => {
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

    const split = splitTraceJsonl(lines.join("\n") + "\n", "connector");

    expect(split.byChargePoint.get("CP-A-connector1")).toContain(
      '"messageId":"boot"',
    );
    expect(split.byChargePoint.get("CP-A-connector2")).toContain(
      '"messageId":"boot"',
    );
  });

  it("treats connectorId: 0 as station-level (not connector 1), replicated into every connector group", () => {
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

    const split = splitTraceJsonl(lines.join("\n") + "\n", "connector");

    expect(split.byChargePoint.get("CP-A-connector1")).toContain(
      '"messageId":"st0"',
    );
    expect(split.byChargePoint.get("CP-A-connector2")).toContain(
      '"messageId":"st0"',
    );
  });

  it("falls back to one plain-cpId group (not connector-suffixed) when a charge point has no connector-scoped records at all, so nothing is silently dropped", () => {
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

    const split = splitTraceJsonl(lines.join("\n") + "\n", "connector");

    expect(Array.from(split.byChargePoint.keys())).toEqual(["CP-B"]);
    expect(split.byChargePoint.get("CP-B")).toContain('"action":"Heartbeat"');
  });

  it("keeps the split independent per charge point: CP-A's connector groups don't see CP-B's records", () => {
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

    const split = splitTraceJsonl(lines.join("\n") + "\n", "connector");

    expect(Array.from(split.byChargePoint.keys())).toEqual([
      "CP-A-connector1",
      "CP-B-connector1",
    ]);
  });
});
