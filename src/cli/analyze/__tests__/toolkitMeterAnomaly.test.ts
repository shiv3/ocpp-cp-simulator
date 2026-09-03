/**
 * Contract tests for the OCPP DebugKit toolkit's rule 14
 * (`METER_VALUE_ANOMALY`), pinned against the real installed
 * `@ocpp-debugkit/toolkit@0.4.2` -- deliberately not mocked, same convention
 * as runAnalyze.test.ts.
 *
 * History (issue #188 Track 3): rule 14 used to flatten every
 * `sampledValue.value` in a session into one `readings[]` array with no
 * regard for `measurand`, `phase`, `unit`, `location`, or `connectorId`, and
 * then assert that flat sequence never decreases. `analyze` carried a
 * post-processing layer (`meterAnomaly.ts`) that stripped those findings and
 * re-derived them correctly. 0.4.2 fixes the rule upstream -- readings are
 * now bucketed by `(connectorId, measurand, phase, unit, location)` and only
 * the cumulative `Energy.*.Register` measurands are checked -- so that layer
 * was removed as redundant.
 *
 * These fixtures stay: they are exactly the "re-verify the test matrix in
 * `src/cli/analyze/__tests__/`" gate that docs/entities/analyze.md requires on a toolkit
 * upgrade. If a future version regresses rule 14 back to the flat-series
 * behavior, the false-positive cases below fail and `analyze` does not
 * silently start reporting noise again.
 */
import { describe, expect, it } from "vitest";
import {
  buildSessionTimeline,
  detectFailures,
  parseOpenOcppTrace,
} from "@ocpp-debugkit/toolkit/core";
import type { Failure, Session } from "@ocpp-debugkit/toolkit/core";

function rec(o: Record<string, unknown>): string {
  return JSON.stringify({
    schemaVersion: "1.1",
    ocppVersion: "1.6",
    transport: "json",
    chargePointId: "CP001",
    ...o,
  });
}

function meterValuesRecord(o: {
  messageId: string;
  timestamp: string;
  connectorId: number;
  transactionId?: number;
  sampledValue: Record<string, unknown>[];
}): string {
  return rec({
    connectorId: o.connectorId,
    timestamp: o.timestamp,
    direction: "cp-to-csms",
    messageType: "CALL",
    messageId: o.messageId,
    action: "MeterValues",
    payload: {
      connectorId: o.connectorId,
      ...(o.transactionId !== undefined
        ? { transactionId: o.transactionId }
        : {}),
      meterValue: [{ timestamp: o.timestamp, sampledValue: o.sampledValue }],
    },
  });
}

/** Parses a joined-lines JSONL trace through the real toolkit pipeline up to
 *  (but not including) `summarizeSessions`, exactly the slice `runAnalyze.ts`
 *  assembles. */
function runToolkitPipeline(lines: string[]): {
  sessions: Session[];
  failures: Failure[];
} {
  const { events } = parseOpenOcppTrace(lines.join("\n") + "\n");
  const sessions = buildSessionTimeline(events);
  const failures = detectFailures(events, sessions);
  return { sessions, failures };
}

function meterAnomalyFindings(failures: Failure[]): Failure[] {
  return failures.filter((f) => f.code === "METER_VALUE_ANOMALY");
}

describe("toolkit rule 14 (METER_VALUE_ANOMALY) contract", () => {
  it("real-world case: a strictly-monotonic Energy.Active.Import.Register series interleaved with a constant Power.Active.Import reports nothing", () => {
    // 12 MeterValues, connector 1, transaction 1001: Energy register rises
    // +25 Wh every 30s (a healthy 3 kW session over 6 minutes), interleaved
    // with a constant Power.Active.Import = 3000 W in the *same* message --
    // exactly the real observed shape from issue #188. Pre-0.4.2 this
    // produced 22 false "value decreased from 3000 to 625" warnings.
    const lines: string[] = [
      rec({
        timestamp: "2026-01-01T00:00:00.000Z",
        direction: "cp-to-csms",
        messageType: "CALL",
        messageId: "1",
        action: "StartTransaction",
        connectorId: 1,
        payload: {
          connectorId: 1,
          idTag: "TAG1",
          meterStart: 600,
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      }),
      rec({
        timestamp: "2026-01-01T00:00:01.000Z",
        direction: "csms-to-cp",
        messageType: "CALLRESULT",
        messageId: "1",
        payload: { idTagInfo: { status: "Accepted" }, transactionId: 1001 },
      }),
    ];
    let energy = 600;
    for (let i = 0; i < 12; i++) {
      const t = new Date(2026, 0, 1, 0, 0, 30 * (i + 1)).toISOString();
      lines.push(
        meterValuesRecord({
          messageId: `mv-${i}`,
          timestamp: t,
          connectorId: 1,
          transactionId: 1001,
          sampledValue: [
            {
              value: String(energy),
              measurand: "Energy.Active.Import.Register",
              unit: "Wh",
            },
            {
              value: "3000",
              measurand: "Power.Active.Import",
              unit: "W",
            },
          ],
        }),
      );
      energy += 25;
    }
    lines.push(
      rec({
        timestamp: "2026-01-01T00:07:00.000Z",
        direction: "cp-to-csms",
        messageType: "CALL",
        messageId: "99",
        action: "StopTransaction",
        payload: {
          transactionId: 1001,
          meterStart: 600,
          meterStop: energy,
          timestamp: "2026-01-01T00:07:00.000Z",
          idTag: "TAG1",
          reason: "Local",
        },
      }),
    );

    const { failures } = runToolkitPipeline(lines);
    expect(meterAnomalyFindings(failures)).toEqual([]);
  });

  it("real-world case: a 4-connector-station-shaped trace with no StartTransaction correlation collapses into one toolkit session, and the two connectors' independent Energy registers still do not cross-contaminate", () => {
    // No StartTransaction/StopTransaction at all: buildSessionTimeline's
    // `startTxCalls.length === 0` fallback lumps every event into a single
    // `session-0`, with `session.transactionId` taken from whichever event
    // is scanned first that carries one -- here, connector 1's first
    // MeterValues. Every other connector's MeterValues still lands in that
    // same session (buildSessionTimeline groups by chargePointId only when
    // there is no transaction to key on), so rule 14 has to separate them by
    // `connectorId` itself. Pre-0.4.2 it did not, and this shape produced 80
    // false warnings on a real 4-connector trace.
    const lines: string[] = [];
    let e1 = 600;
    let e2 = 9000;
    for (let i = 0; i < 6; i++) {
      const t1 = new Date(2026, 0, 1, 0, 0, 60 * i).toISOString();
      lines.push(
        meterValuesRecord({
          messageId: `c1-${i}`,
          timestamp: t1,
          connectorId: 1,
          transactionId: 1001,
          sampledValue: [
            { value: String(e1), measurand: "Energy.Active.Import.Register" },
          ],
        }),
      );
      e1 += 25;
      const t2 = new Date(2026, 0, 1, 0, 0, 60 * i + 30).toISOString();
      lines.push(
        meterValuesRecord({
          messageId: `c2-${i}`,
          timestamp: t2,
          connectorId: 2,
          transactionId: 2002,
          sampledValue: [
            { value: String(e2), measurand: "Energy.Active.Import.Register" },
          ],
        }),
      );
      e2 += 40;
    }

    const { sessions, failures } = runToolkitPipeline(lines);
    expect(sessions).toHaveLength(1); // confirms the fallback single-session shape
    expect(meterAnomalyFindings(failures)).toEqual([]);
  });

  it("still flags a genuinely non-monotonic cumulative register (true positive preserved)", () => {
    const lines: string[] = [
      meterValuesRecord({
        messageId: "mv-0",
        timestamp: "2026-01-01T00:00:00.000Z",
        connectorId: 1,
        transactionId: 1001,
        sampledValue: [
          { value: "1000", measurand: "Energy.Active.Import.Register" },
        ],
      }),
      meterValuesRecord({
        messageId: "mv-1",
        timestamp: "2026-01-01T00:00:30.000Z",
        connectorId: 1,
        transactionId: 1001,
        sampledValue: [
          // meter reset / rollover -- a real anomaly.
          { value: "500", measurand: "Energy.Active.Import.Register" },
        ],
      }),
    ];

    const { sessions, failures } = runToolkitPipeline(lines);
    const findings = meterAnomalyFindings(failures);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.description).toContain("decreased from 1000 to 500");
    // eventIds must reference real events in the session: summarizeSessions'
    // per-session failureCount intersects them against session.events.
    const sessionEventIds = new Set(
      sessions.flatMap((s) => s.events.map((e) => e.id)),
    );
    for (const id of findings[0]?.eventIds ?? []) {
      expect(sessionEventIds.has(id)).toBe(true);
    }
  });

  it("flags a negative cumulative register value", () => {
    const lines: string[] = [
      meterValuesRecord({
        messageId: "mv-0",
        timestamp: "2026-01-01T00:00:00.000Z",
        connectorId: 1,
        transactionId: 1001,
        sampledValue: [
          { value: "-5", measurand: "Energy.Active.Import.Register" },
        ],
      }),
    ];
    const { failures } = runToolkitPipeline(lines);
    const findings = meterAnomalyFindings(failures);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.description).toContain("Negative meter value");
  });

  it("does NOT flag a negative Power.Active.Import value (legitimate on a bidirectional/V2G charger)", () => {
    const lines: string[] = [
      meterValuesRecord({
        messageId: "mv-0",
        timestamp: "2026-01-01T00:00:00.000Z",
        connectorId: 1,
        transactionId: 1001,
        sampledValue: [
          // Discharging back to the grid: negative power is expected, not
          // an anomaly.
          { value: "-3000", measurand: "Power.Active.Import" },
        ],
      }),
    ];
    const { failures } = runToolkitPipeline(lines);
    expect(meterAnomalyFindings(failures)).toEqual([]);
  });

  it("does NOT flag a negative Current.Import value either", () => {
    const lines: string[] = [
      meterValuesRecord({
        messageId: "mv-0",
        timestamp: "2026-01-01T00:00:00.000Z",
        connectorId: 1,
        transactionId: 1001,
        sampledValue: [{ value: "-16", measurand: "Current.Import" }],
      }),
    ];
    const { failures } = runToolkitPipeline(lines);
    expect(meterAnomalyFindings(failures)).toEqual([]);
  });

  it("treats a missing measurand as Energy.Active.Import.Register (OCPP 1.6 default) and still flags it if non-monotonic", () => {
    const lines: string[] = [
      meterValuesRecord({
        messageId: "mv-0",
        timestamp: "2026-01-01T00:00:00.000Z",
        connectorId: 1,
        transactionId: 1001,
        sampledValue: [{ value: "1000" }], // no measurand at all
      }),
      meterValuesRecord({
        messageId: "mv-1",
        timestamp: "2026-01-01T00:00:30.000Z",
        connectorId: 1,
        transactionId: 1001,
        sampledValue: [{ value: "900" }],
      }),
    ];
    const { failures } = runToolkitPipeline(lines);
    expect(meterAnomalyFindings(failures)).toHaveLength(1);
  });

  it("does not flag non-cumulative measurands even when they legitimately fall and rise (SoC, Power, Current, Voltage, Temperature)", () => {
    const lines: string[] = [
      meterValuesRecord({
        messageId: "mv-0",
        timestamp: "2026-01-01T00:00:00.000Z",
        connectorId: 1,
        transactionId: 1001,
        sampledValue: [
          { value: "80", measurand: "SoC" },
          { value: "7200", measurand: "Power.Active.Import" },
          { value: "32", measurand: "Current.Import" },
          { value: "230", measurand: "Voltage" },
          { value: "35", measurand: "Temperature" },
        ],
      }),
      meterValuesRecord({
        messageId: "mv-1",
        timestamp: "2026-01-01T00:00:30.000Z",
        connectorId: 1,
        transactionId: 1001,
        sampledValue: [
          { value: "60", measurand: "SoC" }, // taper -- falling is normal
          { value: "1200", measurand: "Power.Active.Import" }, // taper
          { value: "5", measurand: "Current.Import" },
          { value: "228", measurand: "Voltage" },
          { value: "34", measurand: "Temperature" },
        ],
      }),
    ];
    const { failures } = runToolkitPipeline(lines);
    expect(meterAnomalyFindings(failures)).toEqual([]);
  });

  it("keeps separate phases of the same cumulative measurand from cross-contaminating", () => {
    const lines: string[] = [
      meterValuesRecord({
        messageId: "mv-0",
        timestamp: "2026-01-01T00:00:00.000Z",
        connectorId: 1,
        transactionId: 1001,
        sampledValue: [
          {
            value: "100",
            measurand: "Energy.Active.Import.Register",
            phase: "L1",
          },
          {
            value: "9000",
            measurand: "Energy.Active.Import.Register",
            phase: "L2",
          },
        ],
      }),
      meterValuesRecord({
        messageId: "mv-1",
        timestamp: "2026-01-01T00:00:30.000Z",
        connectorId: 1,
        transactionId: 1001,
        sampledValue: [
          {
            value: "125",
            measurand: "Energy.Active.Import.Register",
            phase: "L1",
          },
          {
            value: "9025",
            measurand: "Energy.Active.Import.Register",
            phase: "L2",
          },
        ],
      }),
    ];
    const { failures } = runToolkitPipeline(lines);
    // Without phase-awareness the rule would see 100, 9000, 125, 9025 and
    // flag 9000 -> 125 as a decrease.
    expect(meterAnomalyFindings(failures)).toEqual([]);
  });

  it("skips sessions with no transactionId (rule 14's own documented scope)", () => {
    // No StartTransaction anywhere and only one connector -> a single
    // no-transaction session, which rule 14 skips outright.
    const lines: string[] = [
      meterValuesRecord({
        messageId: "mv-0",
        timestamp: "2026-01-01T00:00:00.000Z",
        connectorId: 1,
        sampledValue: [
          { value: "1000", measurand: "Energy.Active.Import.Register" },
        ],
      }),
      meterValuesRecord({
        messageId: "mv-1",
        timestamp: "2026-01-01T00:00:30.000Z",
        connectorId: 1,
        sampledValue: [
          // Would be a real anomaly if the session had a transactionId.
          { value: "500", measurand: "Energy.Active.Import.Register" },
        ],
      }),
    ];
    const { sessions, failures } = runToolkitPipeline(lines);
    expect(sessions[0]?.transactionId).toBeNull();
    expect(meterAnomalyFindings(failures)).toEqual([]);
  });
});
