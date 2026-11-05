import { describe, expect, it } from "vitest";
import { evaluateMonitor, type MonitoredReading } from "../evaluateMonitor";
import {
  MonitorEvaluation,
  type MonitorEvaluationDeps,
  type MonitoringEvent,
} from "../MonitorEvaluation";
import { MonitoringStore, type MonitorDraft } from "../MonitoringStore";

const INTEGER = { numeric: true } as const;
const BOOLEAN = { numeric: false } as const;

const num = (n: number): MonitoredReading => ({ numeric: n, text: String(n) });
const text = (t: string): MonitoredReading => ({ text: t });

describe("evaluateMonitor", () => {
  const upper = { type: "UpperThreshold", value: 50 } as const;
  const lower = { type: "LowerThreshold", value: 50 } as const;
  const delta = { type: "Delta", value: 10 } as const;

  it("triggers an UpperThreshold only above the value, then clears it (N07.FR.16, FR.02)", () => {
    const set = evaluateMonitor(upper, undefined, num(40));
    expect(set.notice).toBeUndefined();

    const onThreshold = evaluateMonitor(upper, set.state, num(50));
    expect(onThreshold.notice).toBeUndefined();
    expect(onThreshold.state.triggered).toBe(false);

    const above = evaluateMonitor(upper, onThreshold.state, num(51));
    expect(above.notice).toEqual({ trigger: "Alerting", cleared: false });
    expect(above.state.triggered).toBe(true);

    const stillAbove = evaluateMonitor(upper, above.state, num(80));
    expect(stillAbove.notice).toBeUndefined();

    const back = evaluateMonitor(upper, stillAbove.state, num(50));
    expect(back.notice).toEqual({ trigger: "Alerting", cleared: true });
    expect(back.state.triggered).toBe(false);
  });

  it("triggers a LowerThreshold only below the value, then clears it (N07.FR.17, FR.02)", () => {
    const set = evaluateMonitor(lower, undefined, num(60));
    expect(evaluateMonitor(lower, set.state, num(50)).notice).toBeUndefined();

    const below = evaluateMonitor(lower, set.state, num(49));
    expect(below.notice).toEqual({ trigger: "Alerting", cleared: false });

    const back = evaluateMonitor(lower, below.state, num(55));
    expect(back.notice).toEqual({ trigger: "Alerting", cleared: true });
  });

  it("triggers a threshold the value already exceeds when the monitor is set", () => {
    const set = evaluateMonitor(upper, undefined, num(70));
    expect(set.notice).toEqual({ trigger: "Alerting", cleared: false });
    expect(set.state.triggered).toBe(true);
  });

  it("measures a numeric Delta from the last notice, strictly (N07.FR.18)", () => {
    const set = evaluateMonitor(delta, undefined, num(60));
    expect(set.notice).toBeUndefined();

    const exactly = evaluateMonitor(delta, set.state, num(70));
    expect(exactly.notice).toBeUndefined();
    // Drift below the step does not move the baseline.
    expect(exactly.state.baseline).toEqual(num(60));

    const over = evaluateMonitor(delta, exactly.state, num(71));
    expect(over.notice).toEqual({ trigger: "Delta", cleared: false });
    expect(over.state.baseline).toEqual(num(71));

    const down = evaluateMonitor(delta, over.state, num(60));
    expect(down.notice).toEqual({ trigger: "Delta", cleared: false });
  });

  it("fires a non-numeric Delta on any change, whatever its value (N07.FR.19)", () => {
    const set = evaluateMonitor(delta, undefined, text("true"));
    expect(evaluateMonitor(delta, set.state, text("true")).notice).toBe(
      undefined,
    );
    const changed = evaluateMonitor(delta, set.state, text("false"));
    expect(changed.notice).toEqual({ trigger: "Delta", cleared: false });
    expect(changed.state.baseline).toEqual(text("false"));
  });
});

interface Harness {
  store: MonitoringStore;
  values: Map<string, MonitoredReading>;
  events: MonitoringEvent[];
  triggered: [number, boolean][];
  evaluation: MonitorEvaluation;
  transaction: { active: boolean };
  change(key: string, reading: MonitoredReading): void;
}

function harness(
  options: {
    store?: MonitoringStore;
    restored?: ReadonlyMap<number, boolean>;
    values?: Record<string, MonitoredReading>;
    transactionIdOf?: MonitorEvaluationDeps["transactionIdOf"];
  } = {},
): Harness {
  const store = options.store ?? new MonitoringStore();
  const values = new Map<string, MonitoredReading>(
    Object.entries(options.values ?? { HeartbeatInterval: num(40) }),
  );
  const events: MonitoringEvent[] = [];
  const triggered: [number, boolean][] = [];
  const transaction = { active: false };
  const evaluation = new MonitorEvaluation(
    {
      store,
      read: (key) => values.get(key),
      emit: (batch) => events.push(...batch),
      transactionActive: () => transaction.active,
      now: () => new Date("2026-10-29T12:00:00.000Z"),
      onTriggeredChange: (id, value) => triggered.push([id, value]),
      ...(options.transactionIdOf && {
        transactionIdOf: options.transactionIdOf,
      }),
    },
    options.restored,
  );
  return {
    store,
    values,
    events,
    triggered,
    evaluation,
    transaction,
    change(key, reading) {
      values.set(key, reading);
      evaluation.valueChanged(key);
    },
  };
}

function draft(overrides: Partial<MonitorDraft> = {}): MonitorDraft {
  return {
    type: "UpperThreshold",
    severity: 5,
    value: 50,
    component: { name: "OCPPCommCtrlr" },
    variable: { name: "HeartbeatInterval" },
    valueKey: "HeartbeatInterval",
    valueType: INTEGER,
    ...overrides,
  };
}

describe("MonitorEvaluation", () => {
  it("emits a trigger and a cleared event for the monitor that fired (N07.FR.02, FR.06)", () => {
    const h = harness();
    h.store.install(draft());
    h.change("HeartbeatInterval", num(60));
    h.change("HeartbeatInterval", num(45));

    expect(h.events).toEqual([
      {
        eventId: 1,
        timestamp: new Date("2026-10-29T12:00:00.000Z"),
        monitor: h.store.get(1),
        trigger: "Alerting",
        cleared: false,
        actualValue: "60",
      },
      {
        eventId: 2,
        timestamp: new Date("2026-10-29T12:00:00.000Z"),
        monitor: h.store.get(1),
        trigger: "Alerting",
        cleared: true,
        actualValue: "45",
      },
    ]);
    expect(h.triggered).toEqual([
      [1, true],
      [1, false],
    ]);
  });

  it("reports every monitor one change fired in one batch, by id", () => {
    const store = new MonitoringStore();
    const batches: number[][] = [];
    const values = new Map([["HeartbeatInterval", num(40)]]);
    const evaluation = new MonitorEvaluation({
      store,
      read: (key) => values.get(key),
      emit: (batch) => batches.push(batch.map((e) => e.monitor.id)),
      transactionActive: () => false,
    });
    store.install(draft());
    store.install(draft({ type: "Delta", value: 5 }));
    values.set("HeartbeatInterval", num(60));
    evaluation.valueChanged("HeartbeatInterval");
    expect(batches).toEqual([[1, 2]]);
  });

  it("ignores changes of other values", () => {
    const h = harness({
      values: { HeartbeatInterval: num(40), ResetRetries: num(1) },
    });
    h.store.install(draft());
    h.change("ResetRetries", num(99));
    expect(h.events).toEqual([]);
  });

  it("drops events of monitors whose severity is above the monitoring level (N05.FR.03, N07.FR.15)", () => {
    const h = harness();
    h.store.install(draft({ severity: 6 }));
    h.store.install(draft({ type: "Delta", value: 1, severity: 5 }));
    h.store.setMonitoringLevel(5);

    h.change("HeartbeatInterval", num(60));
    expect(h.events.map((e) => [e.monitor.id, e.trigger])).toEqual([
      [2, "Delta"],
    ]);
    // The filtered monitor still tracks its state: no replayed trigger
    // when the level is raised again.
    expect(h.evaluation.isTriggered(1)).toBe(true);
    h.store.setMonitoringLevel(9);
    h.change("HeartbeatInterval", num(45));
    expect(h.events.map((e) => [e.monitor.id, e.cleared])).toEqual([
      [2, false],
      [1, true],
      [2, false],
    ]);
  });

  it("reports a transaction monitor only while a transaction runs", () => {
    const h = harness();
    h.store.install(draft({ transaction: true }));
    h.change("HeartbeatInterval", num(60));
    expect(h.events).toEqual([]);

    h.transaction.active = true;
    h.change("HeartbeatInterval", num(45));
    expect(h.events.map((e) => e.cleared)).toEqual([true]);
  });

  it("links an event to the transaction the charge point names for its monitor (#538)", () => {
    const h = harness({
      transactionIdOf: (m) => (m.component.evse?.id === 1 ? "tx-1" : undefined),
    });
    h.store.install(
      draft({ component: { name: "OCPPCommCtrlr", evse: { id: 1 } } }),
    );
    h.store.install(draft({ severity: 6 }));
    h.change("HeartbeatInterval", num(60));

    expect(h.events.map((e) => [e.monitor.id, e.transactionId])).toEqual([
      [1, "tx-1"],
      [2, undefined],
    ]);
  });

  it("evaluates a new monitor against the current value", () => {
    const h = harness({ values: { HeartbeatInterval: num(70) } });
    h.store.install(draft());
    expect(h.events.map((e) => [e.trigger, e.cleared])).toEqual([
      ["Alerting", false],
    ]);
  });

  it("re-checks a replaced threshold: a new threshold that clears the old one sends cleared (N07.FR.11)", () => {
    const h = harness();
    h.store.install(draft());
    h.change("HeartbeatInterval", num(60));
    h.store.install(draft({ id: 1, value: 80 }));
    expect(h.events.map((e) => [e.monitor.value, e.cleared])).toEqual([
      [50, false],
      [80, true],
    ]);
  });

  it("re-checks a replaced threshold: a new threshold the value exceeds triggers (N07.FR.11)", () => {
    const h = harness();
    h.store.install(draft());
    h.store.install(draft({ id: 1, value: 30 }));
    expect(h.events.map((e) => [e.monitor.value, e.cleared])).toEqual([
      [30, false],
    ]);
  });

  it("sends no cleared event when a triggered monitor is removed (N07.FR.12)", () => {
    const h = harness();
    h.store.install(draft());
    h.change("HeartbeatInterval", num(60));
    h.store.clear(1);
    h.change("HeartbeatInterval", num(40));
    expect(h.events.map((e) => e.cleared)).toEqual([false]);
  });

  it("leaves an empty actualValue for a write-only value (N07.FR.10)", () => {
    const h = harness({ values: { AuthorizationKey: text("") } });
    h.store.install(
      draft({
        type: "Delta",
        value: 0,
        valueKey: "AuthorizationKey",
        valueType: BOOLEAN,
      }),
    );
    // A write-only value reads as "" every time, so a Delta cannot see it
    // change; nothing leaks.
    h.change("AuthorizationKey", text(""));
    expect(h.events).toEqual([]);
  });

  it("restores the triggered flag so a value back in range after a reboot sends cleared (N07.FR.14)", () => {
    const store = new MonitoringStore();
    store.restore([
      {
        id: 4,
        type: "UpperThreshold",
        severity: 5,
        value: 50,
        transaction: false,
        component: { name: "OCPPCommCtrlr" },
        variable: { name: "HeartbeatInterval" },
        valueKey: "HeartbeatInterval",
        origin: "CustomMonitor",
      },
    ]);
    const h = harness({
      store,
      restored: new Map([[4, true]]),
      values: { HeartbeatInterval: num(60) },
    });
    // Restoring is silent.
    expect(h.events).toEqual([]);
    expect(h.evaluation.isTriggered(4)).toBe(true);

    h.change("HeartbeatInterval", num(40));
    expect(h.events.map((e) => [e.monitor.id, e.cleared])).toEqual([[4, true]]);
  });

  it("keeps the baseline of a Delta filtered by the monitoring level (N07.FR.18)", () => {
    const h = harness();
    h.store.install(draft({ type: "Delta", value: 100, severity: 8 }));
    h.store.setMonitoringLevel(7);
    h.change("HeartbeatInterval", num(100));
    h.change("HeartbeatInterval", num(160));
    expect(h.events).toEqual([]);

    // 121 from the value the monitor was set on (40): no notice was sent
    // since, so the baseline did not move.
    h.store.setMonitoringLevel(9);
    h.change("HeartbeatInterval", num(161));
    expect(h.events.map((e) => [e.trigger, e.actualValue])).toEqual([
      ["Delta", "161"],
    ]);
  });

  it("keeps the baseline of a transaction Delta while no transaction runs", () => {
    const h = harness();
    h.store.install(draft({ type: "Delta", value: 10, transaction: true }));
    h.change("HeartbeatInterval", num(60));
    h.transaction.active = true;
    h.change("HeartbeatInterval", num(55));
    expect(h.events.map((e) => e.actualValue)).toEqual(["55"]);
  });

  it("sends nothing while reporting is off, then reports the thresholds' current state (B02.FR.02)", () => {
    const h = harness();
    h.store.install(draft());
    h.store.install(draft({ type: "LowerThreshold", value: 30 }));
    h.store.install(draft({ type: "Delta", value: 5 }));
    h.change("HeartbeatInterval", num(20));
    expect(h.events.map((e) => [e.monitor.id, e.cleared])).toEqual([
      [2, false],
      [3, false],
    ]);

    h.evaluation.setReporting(false);
    h.store.install(draft({ type: "UpperThreshold", value: 10, severity: 3 }));
    h.change("HeartbeatInterval", num(60));
    h.change("HeartbeatInterval", num(61));
    expect(h.events).toHaveLength(2);
    // The persisted flags still say what the CSMS was last told.
    expect(h.evaluation.isTriggered(1)).toBe(false);
    expect(h.evaluation.isTriggered(2)).toBe(true);
    expect(h.evaluation.isTriggered(4)).toBe(false);

    h.evaluation.setReporting(true);
    expect(
      h.events.slice(2).map((e) => [e.monitor.id, e.trigger, e.cleared]),
    ).toEqual([
      [1, "Alerting", false],
      [2, "Alerting", true],
      [4, "Alerting", false],
    ]);
    // A Delta is not re-checked; its baseline (20) is kept for the next
    // change.
    h.change("HeartbeatInterval", num(62));
    expect(h.events.slice(5).map((e) => [e.monitor.id, e.trigger])).toEqual([
      [3, "Delta"],
    ]);
  });

  it("sends the cleared event of a restored trigger whose value is already back in range (N07.FR.14)", () => {
    const store = new MonitoringStore();
    store.restore([
      {
        id: 4,
        type: "UpperThreshold",
        severity: 5,
        value: 50,
        transaction: false,
        component: { name: "OCPPCommCtrlr" },
        variable: { name: "HeartbeatInterval" },
        valueKey: "HeartbeatInterval",
        origin: "CustomMonitor",
      },
    ]);
    const h = harness({
      store,
      restored: new Map([[4, true]]),
      values: { HeartbeatInterval: num(40) },
    });
    h.evaluation.setReporting(false);
    h.evaluation.setReporting(true);
    expect(h.events.map((e) => [e.monitor.id, e.cleared])).toEqual([[4, true]]);
    expect(h.triggered).toEqual([[4, false]]);
  });

  it("clears a triggered threshold replaced by a monitor of another type that is not triggered (N07.FR.11)", () => {
    const h = harness();
    h.store.install(draft({ severity: 4 }));
    h.change("HeartbeatInterval", num(60));
    h.store.install(draft({ id: 1, type: "Delta", value: 5, severity: 6 }));
    expect(
      h.events.map((e) => [e.monitor.type, e.monitor.severity, e.cleared]),
    ).toEqual([
      ["UpperThreshold", 4, false],
      // The cleared event describes the condition that ends.
      ["UpperThreshold", 4, true],
    ]);
    expect(h.triggered).toEqual([
      [1, true],
      [1, false],
    ]);

    // A threshold of the other kind the value does not exceed.
    h.store.install(draft({ value: 50 }));
    h.store.install(draft({ id: 2, type: "LowerThreshold", value: 30 }));
    expect(h.events.slice(3).map((e) => [e.monitor.type, e.cleared])).toEqual([
      ["UpperThreshold", true],
    ]);
  });

  it("sends only the trigger when the replacement of another type is triggered too (N07.FR.11)", () => {
    const h = harness();
    h.store.install(draft());
    h.change("HeartbeatInterval", num(60));
    h.store.install(draft({ id: 1, type: "LowerThreshold", value: 70 }));
    expect(h.events.map((e) => [e.monitor.type, e.cleared])).toEqual([
      ["UpperThreshold", false],
      ["LowerThreshold", false],
    ]);
  });

  it("defers a replacement of another type while reporting is off: trigger or cleared on resume (N07.FR.11)", () => {
    const h = harness();
    h.store.install(draft());
    h.store.install(draft({ value: 55, severity: 6 }));
    h.change("HeartbeatInterval", num(60));
    h.evaluation.setReporting(false);
    // Exceeded too: its trigger is owed.
    h.store.install(draft({ id: 1, type: "LowerThreshold", value: 70 }));
    // Not exceeded: the old trigger's cleared is owed.
    h.store.install(
      draft({ id: 2, type: "LowerThreshold", value: 30, severity: 6 }),
    );
    expect(h.events).toHaveLength(2);

    h.evaluation.setReporting(true);
    expect(
      h.events.slice(2).map((e) => [e.monitor.id, e.monitor.type, e.cleared]),
    ).toEqual([
      [1, "LowerThreshold", false],
      [2, "LowerThreshold", true],
    ]);
  });
});

describe("MonitoringStore.restore", () => {
  it("installs persisted monitors silently and resumes ids after the highest (N04.FR.19, N07.FR.13)", () => {
    const store = new MonitoringStore();
    const seen: string[] = [];
    store.onChange((e) => seen.push(e.kind));
    store.restore([
      {
        id: 7,
        type: "Delta",
        severity: 3,
        value: 1,
        transaction: false,
        component: { name: "OCPPCommCtrlr" },
        variable: { name: "HeartbeatInterval" },
        valueKey: "HeartbeatInterval",
        origin: "CustomMonitor",
      },
    ]);
    expect(seen).toEqual([]);
    expect(store.list().map((m) => m.id)).toEqual([7]);
    expect(store.install(draft())).toMatchObject({ monitor: { id: 8 } });
  });
});

describe("MonitoringStore.applyMonitoringBase", () => {
  function storeWithTwo(): MonitoringStore {
    const store = new MonitoringStore();
    store.install(draft());
    store.install(draft({ type: "Delta", value: 1 }));
    return store;
  }

  it("All keeps the custom monitors (N03.FR.03)", () => {
    const store = storeWithTwo();
    expect(store.applyMonitoringBase("All")).toBe("Accepted");
    expect(store.list().map((m) => m.id)).toEqual([1, 2]);
  });

  it.each(["FactoryDefault", "HardWiredOnly"] as const)(
    "%s deletes every custom monitor (N03.FR.04, FR.05)",
    (base) => {
      const store = storeWithTwo();
      const cleared: number[] = [];
      store.onChange((e) => {
        if (e.kind === "cleared") cleared.push(e.monitor.id);
      });
      expect(store.applyMonitoringBase(base)).toBe("Accepted");
      expect(store.list()).toEqual([]);
      expect(cleared).toEqual([1, 2]);
    },
  );

  it("answers NotSupported for a base it does not know (N03.FR.02)", () => {
    const store = storeWithTwo();
    expect(store.applyMonitoringBase("Everything")).toBe("NotSupported");
    expect(store.list()).toHaveLength(2);
  });
});
