import { describe, expect, it } from "vitest";
import { OperationalTimeline } from "../OperationalTimeline";

function fixedClock(start = Date.UTC(2026, 9, 27, 15, 21, 10)) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("OperationalTimeline (#448)", () => {
  it("numbers entries with a monotonic seq and stamps cpId and an ISO timestamp", () => {
    const clock = fixedClock();
    const timeline = new OperationalTimeline("CP-1", { now: clock.now });

    timeline.record({ kind: "connected", summary: "Connected" });
    clock.advance(1500);
    timeline.record({ kind: "disconnected", summary: "Disconnected" });

    expect(timeline.query().entries).toEqual([
      {
        seq: 1,
        timestamp: "2026-10-27T15:21:10.000Z",
        kind: "connected",
        cpId: "CP-1",
        summary: "Connected",
        data: {},
      },
      {
        seq: 2,
        timestamp: "2026-10-27T15:21:11.500Z",
        kind: "disconnected",
        cpId: "CP-1",
        summary: "Disconnected",
        data: {},
      },
    ]);
  });

  it("evicts the oldest entries past its capacity without reusing seq", () => {
    const timeline = new OperationalTimeline("CP-1", { capacity: 2 });

    for (let i = 0; i < 3; i++) {
      timeline.record({ kind: "connected", summary: `#${i}` });
    }

    const { entries, total } = timeline.query();
    expect(total).toBe(2);
    expect(entries.map((e) => e.seq)).toEqual([2, 3]);
  });

  it("stamps connector entries with the connector's active scenario run", () => {
    const timeline = new OperationalTimeline("CP-1");
    timeline.startRun(1, "run-a");

    timeline.record({ kind: "connector_status", connectorId: 1, summary: "" });
    timeline.record({ kind: "connector_status", connectorId: 2, summary: "" });
    timeline.record({ kind: "connected", summary: "" });
    timeline.endRun(1, "run-a");
    timeline.record({ kind: "connector_status", connectorId: 1, summary: "" });

    expect(timeline.query().entries.map((e) => e.runId)).toEqual([
      "run-a",
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("attributes to the latest run still active when runs overlap", () => {
    const timeline = new OperationalTimeline("CP-1");
    timeline.startRun(1, "parked");
    timeline.startRun(1, "driven");

    timeline.record({ kind: "connector_status", connectorId: 1, summary: "" });
    timeline.endRun(1, "driven");
    timeline.record({ kind: "connector_status", connectorId: 1, summary: "" });
    timeline.endRun(1, "driven");
    timeline.endRun(1, "parked");
    timeline.record({ kind: "connector_status", connectorId: 1, summary: "" });

    expect(timeline.query().entries.map((e) => e.runId)).toEqual([
      "driven",
      "parked",
      undefined,
    ]);
  });

  it("keeps an explicit runId over the active one", () => {
    const timeline = new OperationalTimeline("CP-1");
    timeline.startRun(1, "run-a");

    timeline.record({
      kind: "scenario_started",
      connectorId: 1,
      runId: "run-b",
      summary: "",
    });

    expect(timeline.query().entries[0]?.runId).toBe("run-b");
  });

  it("stamps every entry with the active incident until it is cleared", () => {
    const timeline = new OperationalTimeline("CP-1");
    timeline.setActiveIncident("inc-1");

    timeline.record({ kind: "disconnected", summary: "" });
    timeline.record({ kind: "scenario_error", connectorId: 1, summary: "" });
    timeline.setActiveIncident(null);
    timeline.record({ kind: "connected", summary: "" });

    expect(timeline.query().entries.map((e) => e.incidentId)).toEqual([
      "inc-1",
      "inc-1",
      undefined,
    ]);
  });

  it("filters by connector, run, incident and kinds, and reports the filtered total", () => {
    const timeline = new OperationalTimeline("CP-1");
    timeline.record({ kind: "connected", summary: "" });
    timeline.setActiveIncident("inc-1");
    timeline.record({ kind: "connector_status", connectorId: 1, summary: "" });
    timeline.setActiveIncident(null);
    timeline.record({ kind: "connector_status", connectorId: 2, summary: "" });
    timeline.record({
      kind: "scenario_started",
      connectorId: 1,
      runId: "run-a",
      summary: "",
    });

    const seqs = (q: Parameters<OperationalTimeline["query"]>[0]) =>
      timeline.query(q).entries.map((e) => e.seq);
    expect(seqs({ connectorId: 1 })).toEqual([2, 4]);
    expect(seqs({ runId: "run-a" })).toEqual([4]);
    expect(seqs({ incidentId: "inc-1" })).toEqual([2]);
    expect(seqs({ kinds: ["connected", "scenario_started"] })).toEqual([1, 4]);
    expect(timeline.query({ connectorId: 1 }).total).toBe(2);
  });

  it("windows like logs.get: limit takes the newest, offset pages back, order flips", () => {
    const timeline = new OperationalTimeline("CP-1");
    for (let i = 0; i < 5; i++) {
      timeline.record({ kind: "connected", summary: "" });
    }

    const seqs = (q: Parameters<OperationalTimeline["query"]>[0]) =>
      timeline.query(q).entries.map((e) => e.seq);
    expect(seqs({ limit: 2 })).toEqual([4, 5]);
    expect(seqs({ limit: 2, offset: 2 })).toEqual([2, 3]);
    expect(seqs({ limit: 2, order: "desc" })).toEqual([5, 4]);
    expect(timeline.query({ limit: 2 }).total).toBe(5);
  });

  it("tells each subscriber about every recorded entry until it unsubscribes", () => {
    const timeline = new OperationalTimeline("CP-1");
    const seen: number[] = [];
    const unsubscribe = timeline.onRecord((entry) => seen.push(entry.seq));

    timeline.record({ kind: "connected", summary: "" });
    timeline.record({ kind: "disconnected", summary: "" });
    unsubscribe();
    timeline.record({ kind: "connected", summary: "" });

    expect(seen).toEqual([1, 2]);
  });

  it("hands out frozen entries, so a caller cannot rewrite history", () => {
    const timeline = new OperationalTimeline("CP-1");
    timeline.record({ kind: "connected", summary: "Connected", data: {} });

    const [entry] = timeline.query().entries;

    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry!.data)).toBe(true);
  });
});
