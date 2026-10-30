import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MonitoredReading } from "../evaluateMonitor";
import { MonitorEvaluation, type MonitoringEvent } from "../MonitorEvaluation";
import { MonitoringStore, type MonitorDraft } from "../MonitoringStore";
import type { VariableMonitor } from "../VariableMonitor";

/**
 * #538: Periodic and PeriodicClockAligned monitors (N08) report the value
 * they watch on a timer, with trigger `Periodic` (N08.FR.05), filtered like
 * the other events and only while reporting is on.
 */

// 12:00:17 UTC: 900 s clock-aligned boundaries are 12:15, 12:30, …
const START = Date.parse("2026-10-28T12:00:17Z");

const num = (n: number): MonitoredReading => ({ numeric: n, text: String(n) });

function harness(store = new MonitoringStore()) {
  const values = new Map<string, MonitoredReading>([
    ["HeartbeatInterval", num(40)],
  ]);
  const events: MonitoringEvent[] = [];
  const batches: number[] = [];
  const transaction = { active: false };
  const evaluation = new MonitorEvaluation({
    store,
    read: (key) => values.get(key),
    emit: (batch) => {
      batches.push(batch.length);
      events.push(...batch);
    },
    transactionActive: () => transaction.active,
  });
  return { store, values, events, batches, evaluation, transaction };
}

function periodic(overrides: Partial<MonitorDraft> = {}): MonitorDraft {
  return {
    type: "Periodic",
    severity: 5,
    value: 60,
    component: { name: "OCPPCommCtrlr" },
    variable: { name: "HeartbeatInterval" },
    valueKey: "HeartbeatInterval",
    valueType: { numeric: true },
    ...overrides,
  };
}

const at = (e: MonitoringEvent) => e.timestamp.toISOString().slice(11, 19);

describe("Periodic monitors (N08)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: START });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports every value seconds from the time the monitor was set, with trigger Periodic (N08.FR.05, FR.06)", () => {
    const h = harness();
    h.store.install(periodic());
    expect(h.events).toEqual([]);

    vi.advanceTimersByTime(59_999);
    expect(h.events).toEqual([]);
    vi.advanceTimersByTime(1);
    h.values.set("HeartbeatInterval", num(45));
    vi.advanceTimersByTime(60_000);

    expect(
      h.events.map((e) => [at(e), e.trigger, e.cleared, e.actualValue]),
    ).toEqual([
      ["12:01:17", "Periodic", false, "40"],
      ["12:02:17", "Periodic", false, "45"],
    ]);
    expect(h.events.map((e) => e.monitor.id)).toEqual([1, 1]);
    // One NotifyEvent per tick, each starting at seqNo 0 (N08.FR.04).
    expect(h.batches).toEqual([1, 1]);
  });

  it("aligns PeriodicClockAligned on the clock: 900 s fires at :15, :30, :45 (N08.FR.07)", () => {
    const h = harness();
    h.store.install(periodic({ type: "PeriodicClockAligned", value: 900 }));
    vi.advanceTimersByTime(45 * 60_000);
    expect(h.events.map(at)).toEqual(["12:15:00", "12:30:00", "12:45:00"]);
  });

  it("does not react to value changes", () => {
    const h = harness();
    h.store.install(periodic());
    h.values.set("HeartbeatInterval", num(4000));
    h.evaluation.valueChanged("HeartbeatInterval");
    h.evaluation.setReporting(false);
    h.evaluation.setReporting(true);
    expect(h.events).toEqual([]);
  });

  it("filters ticks by the monitoring level and the transaction flag (N05.FR.03, N07.FR.15)", () => {
    const h = harness();
    h.store.install(periodic({ severity: 7 }));
    h.store.install(periodic({ severity: 2, transaction: true }));
    h.store.setMonitoringLevel(5);
    vi.advanceTimersByTime(60_000);
    expect(h.events).toEqual([]);

    h.transaction.active = true;
    vi.advanceTimersByTime(60_000);
    expect(h.events.map((e) => e.monitor.id)).toEqual([2]);
  });

  it("sends nothing while reporting is off and restarts the period when it resumes", () => {
    const h = harness();
    h.store.install(periodic());
    vi.advanceTimersByTime(30_000);
    h.evaluation.setReporting(false);
    vi.advanceTimersByTime(10 * 60_000);
    expect(h.events).toEqual([]);

    // 12:10:47: no catch-up tick, the next one is a full period later.
    h.evaluation.setReporting(true);
    expect(h.events).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(h.events.map(at)).toEqual(["12:11:47"]);
  });

  it("stops the timer of a cleared monitor and of a monitor removed by SetMonitoringBase", () => {
    const h = harness();
    h.store.install(periodic());
    h.store.install(periodic({ severity: 6 }));
    h.store.clear(1);
    vi.advanceTimersByTime(60_000);
    expect(h.events.map((e) => e.monitor.id)).toEqual([2]);

    h.store.applyMonitoringBase("FactoryDefault");
    vi.advanceTimersByTime(10 * 60_000);
    expect(h.events).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-arms a replaced monitor with its new interval, and stops it when replaced by another type", () => {
    const h = harness();
    h.store.install(periodic());
    vi.advanceTimersByTime(30_000);
    h.store.install(periodic({ id: 1, value: 120 }));
    vi.advanceTimersByTime(119_999);
    expect(h.events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.events.map(at)).toEqual(["12:02:47"]);

    h.store.install(periodic({ id: 1, type: "Delta", value: 5 }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not arm restored monitors before reporting is on, then arms them", () => {
    const store = new MonitoringStore();
    const restored: VariableMonitor = {
      id: 3,
      type: "Periodic",
      severity: 5,
      value: 60,
      transaction: false,
      component: { name: "OCPPCommCtrlr" },
      variable: { name: "HeartbeatInterval" },
      valueKey: "HeartbeatInterval",
      origin: "CustomMonitor",
    };
    store.restore([restored]);
    const h = harness(store);
    // ChargePoint turns reporting off right after building the evaluation.
    h.evaluation.setReporting(false);
    expect(vi.getTimerCount()).toBe(0);
    h.evaluation.setReporting(true);
    vi.advanceTimersByTime(60_000);
    expect(h.events.map((e) => e.monitor.id)).toEqual([3]);
  });

  it("waits longer than the 24.8-day setTimeout limit without firing early", () => {
    const h = harness();
    const thirtyDays = 30 * 86_400;
    h.store.install(periodic({ value: thirtyDays }));
    vi.advanceTimersByTime(thirtyDays * 1000 - 1);
    expect(h.events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.events).toHaveLength(1);
  });
});
