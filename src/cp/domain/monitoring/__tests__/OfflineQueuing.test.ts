import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MonitoredReading } from "../evaluateMonitor";
import { MonitorEvaluation, type MonitoringEvent } from "../MonitorEvaluation";
import { MonitoringStore, type MonitorDraft } from "../MonitoringStore";
import { isQueuedOffline } from "../monitoringCtrlrKeys";

/**
 * #538, OCPP 2.0.1 / 2.1 N07.FR.04 and N08.FR.03: while the station is
 * offline, the NotifyEvent of a monitor whose severity is equal to or lower
 * than `MonitoringCtrlr.OfflineQueuingSeverity` is queued and delivered
 * once back online. The others are evaluated when the station is back
 * (the "delayed evaluation" of the N07 Remark), so a queued event counts as
 * told and the re-check of the Accepted boot does not repeat it.
 */

const START = Date.parse("2026-10-30T12:00:17Z");

const num = (n: number): MonitoredReading => ({ numeric: n, text: String(n) });

function harness(threshold: number | undefined) {
  const store = new MonitoringStore();
  const values = new Map<string, MonitoredReading>([
    ["HeartbeatInterval", num(40)],
  ]);
  const sent: MonitoringEvent[] = [];
  const queued: MonitoringEvent[] = [];
  const config = { threshold };
  const evaluation = new MonitorEvaluation({
    store,
    read: (key) => values.get(key),
    emit: (batch) => sent.push(...batch),
    queue: (batch) => queued.push(...batch),
    offlineQueuingSeverity: () => config.threshold,
    transactionActive: () => false,
  });
  const change = (value: number) => {
    values.set("HeartbeatInterval", num(value));
    evaluation.valueChanged("HeartbeatInterval");
  };
  return { store, values, sent, queued, config, evaluation, change };
}

function draft(overrides: Partial<MonitorDraft> = {}): MonitorDraft {
  return {
    type: "UpperThreshold",
    severity: 5,
    value: 50,
    component: { name: "OCPPCommCtrlr" },
    variable: { name: "HeartbeatInterval" },
    valueKey: "HeartbeatInterval",
    valueType: { numeric: true },
    ...overrides,
  };
}

const summary = (events: MonitoringEvent[]) =>
  events.map((e) => [e.monitor.id, e.trigger, e.cleared, e.actualValue]);

describe("isQueuedOffline (N07.FR.04)", () => {
  it("queues a severity equal to or lower than the threshold, nothing when unset", () => {
    expect(isQueuedOffline(4, 5)).toBe(true);
    expect(isQueuedOffline(5, 5)).toBe(true);
    expect(isQueuedOffline(6, 5)).toBe(false);
    expect(isQueuedOffline(0, 0)).toBe(true);
    expect(isQueuedOffline(0, undefined)).toBe(false);
  });
});

describe("MonitorEvaluation offline (N07.FR.04)", () => {
  it("queues the events of a monitor at or below OfflineQueuingSeverity, not the others", () => {
    const h = harness(5);
    h.store.install(draft({ severity: 5 }));
    h.store.install(draft({ severity: 6 }));
    h.evaluation.setOffline();

    h.change(60);
    h.change(45);

    expect(h.sent).toEqual([]);
    expect(summary(h.queued)).toEqual([
      [1, "Alerting", false, "60"],
      [1, "Alerting", true, "45"],
    ]);
  });

  it("counts a queued event as told: the re-check once back online reports only the held monitors", () => {
    const h = harness(5);
    h.store.install(draft({ severity: 3 }));
    h.store.install(draft({ severity: 8 }));
    h.evaluation.setOffline();
    h.change(60);
    expect(summary(h.queued)).toEqual([[1, "Alerting", false, "60"]]);
    expect(h.evaluation.isTriggered(1)).toBe(true);
    // The held monitor keeps what the CSMS was last told.
    expect(h.evaluation.isTriggered(2)).toBe(false);

    h.evaluation.setReporting(true);

    expect(summary(h.sent)).toEqual([[2, "Alerting", false, "60"]]);
    expect(h.queued).toHaveLength(1);
  });

  it("still applies the monitoring level offline (N05.FR.03)", () => {
    const h = harness(9);
    h.store.setMonitoringLevel(4);
    h.store.install(draft({ severity: 5 }));
    h.evaluation.setOffline();
    h.change(60);
    expect(h.queued).toEqual([]);
  });

  it("queues nothing when OfflineQueuingSeverity is unset", () => {
    const h = harness(undefined);
    h.store.install(draft({ severity: 0 }));
    h.evaluation.setOffline();
    h.change(60);
    expect(h.queued).toEqual([]);
    h.evaluation.setReporting(true);
    expect(summary(h.sent)).toEqual([[1, "Alerting", false, "60"]]);
  });

  it("moves a queued Delta's baseline, like a sent one (N07.FR.18)", () => {
    const h = harness(5);
    h.store.install(draft({ type: "Delta", value: 5 }));
    h.evaluation.setOffline();
    h.change(46);
    h.evaluation.setReporting(true);
    h.change(50);
    h.change(52);
    expect(summary(h.queued)).toEqual([[1, "Delta", false, "46"]]);
    expect(summary(h.sent)).toEqual([[1, "Delta", false, "52"]]);
  });

  it("queues nothing while the boot is Pending or Rejected (held, not offline)", () => {
    const h = harness(9);
    h.store.install(draft());
    h.evaluation.setReporting(false);
    h.change(60);
    expect(h.queued).toEqual([]);
    expect(h.sent).toEqual([]);
  });
});

describe("MonitorEvaluation offline periodic monitors (N08.FR.03)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: START });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const periodic = (severity: number) =>
    draft({ type: "Periodic", value: 60, severity });

  it("keeps the timers running offline and queues the ticks at or below the threshold", () => {
    const h = harness(5);
    h.store.install(periodic(5));
    h.store.install(periodic(6));
    h.evaluation.setOffline();

    vi.advanceTimersByTime(120_000);

    expect(h.sent).toEqual([]);
    expect(
      h.queued.map((e) => [e.monitor.id, e.trigger, e.timestamp.toISOString()]),
    ).toEqual([
      [1, "Periodic", "2026-10-30T12:01:17.000Z"],
      [1, "Periodic", "2026-10-30T12:02:17.000Z"],
    ]);
  });

  it("keeps the period when the station comes back online", () => {
    const h = harness(5);
    h.store.install(periodic(5));
    h.evaluation.setOffline();
    vi.advanceTimersByTime(90_000);
    h.evaluation.setReporting(true);
    vi.advanceTimersByTime(30_000);
    expect(h.queued.map((e) => e.timestamp.toISOString())).toEqual([
      "2026-10-30T12:01:17.000Z",
    ]);
    expect(h.sent.map((e) => e.timestamp.toISOString())).toEqual([
      "2026-10-30T12:02:17.000Z",
    ]);
  });

  it("arms a periodic monitor installed offline, and stops the timers when held", () => {
    const h = harness(5);
    h.evaluation.setOffline();
    h.store.install(periodic(5));
    vi.advanceTimersByTime(60_000);
    expect(h.queued).toHaveLength(1);

    h.evaluation.setReporting(false);
    expect(vi.getTimerCount()).toBe(0);
    h.evaluation.setOffline();
    vi.advanceTimersByTime(60_000);
    expect(h.queued).toHaveLength(2);
  });

  it("stops every timer on dispose and ignores later mode changes", () => {
    const h = harness(5);
    h.store.install(periodic(5));
    h.evaluation.setOffline();
    h.evaluation.dispose();
    expect(vi.getTimerCount()).toBe(0);
    h.evaluation.setOffline();
    h.evaluation.setReporting(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(600_000);
    expect(h.queued).toEqual([]);
    expect(h.sent).toEqual([]);
  });
});
