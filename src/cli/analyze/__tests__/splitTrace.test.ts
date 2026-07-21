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
});
