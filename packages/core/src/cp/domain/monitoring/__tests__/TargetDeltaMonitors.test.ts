import { describe, expect, it } from "vitest";
import { DeviceModelTargets } from "../../charge-point/DeviceModelTargets";
import { evaluateMonitor, type MonitoredReading } from "../evaluateMonitor";
import { MonitorEvaluation, type MonitoringEvent } from "../MonitorEvaluation";
import { MonitoringStore, type MonitorDraft } from "../MonitoringStore";

/**
 * #538: 2.1 TargetDelta / TargetDeltaRelative monitors (N07.FR.22, FR.23)
 * compare the Actual value of a variable with its Target value, and share
 * the triggered / cleared semantics of the thresholds (N07.FR.02, FR.11,
 * FR.12, FR.14).
 */

const reading = (actual: number, target?: number): MonitoredReading => ({
  numeric: actual,
  text: String(actual),
  ...(target !== undefined && { target }),
});

describe("evaluateMonitor TargetDelta (N07.FR.22)", () => {
  const monitor = { type: "TargetDelta", value: 10 } as const;

  it("fires when the actual value differs from the target by more than the value, then clears", () => {
    const set = evaluateMonitor(monitor, undefined, reading(105, 100));
    expect(set.notice).toBeUndefined();
    // On the bound is not "more than".
    expect(
      evaluateMonitor(monitor, set.state, reading(110, 100)).notice,
    ).toBeUndefined();
    const above = evaluateMonitor(monitor, set.state, reading(111, 100));
    expect(above.notice).toEqual({ trigger: "Alerting", cleared: false });
    // Beyond on the other side: still triggered, nothing new.
    const below = evaluateMonitor(monitor, above.state, reading(89, 100));
    expect(below.notice).toBeUndefined();
    expect(below.state.triggered).toBe(true);
    const back = evaluateMonitor(monitor, below.state, reading(100, 100));
    expect(back.notice).toEqual({ trigger: "Alerting", cleared: true });
  });

  it("keeps its state while the variable has no target", () => {
    const set = evaluateMonitor(monitor, undefined, reading(500));
    expect(set.notice).toBeUndefined();
    expect(set.state.triggered).toBe(false);
    const triggered = evaluateMonitor(monitor, set.state, reading(500, 100));
    expect(triggered.notice).toEqual({ trigger: "Alerting", cleared: false });
    const unset = evaluateMonitor(monitor, triggered.state, reading(100));
    expect(unset.notice).toBeUndefined();
    expect(unset.state.triggered).toBe(true);
  });
});

describe("evaluateMonitor TargetDeltaRelative (N07.FR.23)", () => {
  const monitor = { type: "TargetDeltaRelative", value: 0.1 } as const;

  it("fires beyond value × target: target 100, value 0.1 fires below 90 or above 110", () => {
    const set = evaluateMonitor(monitor, undefined, reading(110, 100));
    expect(set.notice).toBeUndefined();
    expect(
      evaluateMonitor(monitor, set.state, reading(90, 100)).notice,
    ).toBeUndefined();
    expect(
      evaluateMonitor(monitor, set.state, reading(89, 100)).notice,
    ).toEqual({ trigger: "Alerting", cleared: false });
  });

  it("measures the band on the target's magnitude: a negative target, and target 0", () => {
    const negative = evaluateMonitor(monitor, undefined, reading(-111, -100));
    expect(negative.notice).toEqual({ trigger: "Alerting", cleared: false });
    expect(
      evaluateMonitor(monitor, undefined, reading(-95, -100)).notice,
    ).toBeUndefined();
    // Target 0: a band of 0, any other value is beyond it.
    expect(evaluateMonitor(monitor, undefined, reading(0, 0)).notice).toBe(
      undefined,
    );
    expect(evaluateMonitor(monitor, undefined, reading(1, 0)).notice).toEqual({
      trigger: "Alerting",
      cleared: false,
    });
  });
});

function draft(overrides: Partial<MonitorDraft> = {}): MonitorDraft {
  return {
    type: "TargetDelta",
    severity: 5,
    value: 100,
    component: { name: "EVSE", evse: { id: 1 } },
    variable: { name: "Power" },
    valueKey: "EVSEPower1",
    valueType: { numeric: true, hasTarget: true },
    ...overrides,
  };
}

describe("MonitoringStore.install TargetDelta", () => {
  it.each(["TargetDelta", "TargetDeltaRelative"])(
    "accepts %s on a numeric variable with a Target attribute",
    (type) => {
      const store = new MonitoringStore();
      expect(store.install(draft({ type })).status).toBe("Accepted");
    },
  );

  it.each(["TargetDelta", "TargetDeltaRelative"])(
    "answers UnsupportedMonitorType for %s on a variable without a Target (N04.FR.05)",
    (type) => {
      const store = new MonitoringStore();
      expect(
        store.install(draft({ type, valueType: { numeric: true } })).status,
      ).toBe("UnsupportedMonitorType");
    },
  );

  it("rejects a negative TargetDelta value", () => {
    const store = new MonitoringStore();
    expect(store.install(draft({ value: -1 }))).toEqual({
      status: "Rejected",
      reason: "NegativeTargetDelta",
    });
  });
});

describe("MonitorEvaluation with targets", () => {
  function harness() {
    const store = new MonitoringStore();
    const targets = new DeviceModelTargets();
    targets.declare("EVSEPower1");
    let actual = 7400;
    const events: MonitoringEvent[] = [];
    const evaluation = new MonitorEvaluation({
      store,
      read: (key) =>
        key === "EVSEPower1" ? reading(actual, targets.get(key)) : undefined,
      emit: (batch) => events.push(...batch),
      transactionActive: () => false,
    });
    targets.onChange((key) => evaluation.valueChanged(key));
    return {
      store,
      targets,
      events,
      evaluation,
      setActual(value: number) {
        actual = value;
        evaluation.valueChanged("EVSEPower1");
      },
    };
  }

  it("re-evaluates when the target changes, not only the actual value", () => {
    const h = harness();
    h.store.install(draft());
    expect(h.events).toEqual([]);
    h.targets.set("EVSEPower1", 7000);
    h.targets.set("EVSEPower1", 7400);
    expect(h.events.map((e) => [e.trigger, e.cleared, e.actualValue])).toEqual([
      ["Alerting", false, "7400"],
      ["Alerting", true, "7400"],
    ]);
  });

  it("re-checks a TargetDelta when reporting resumes, like a threshold", () => {
    const h = harness();
    h.targets.set("EVSEPower1", 7400);
    h.store.install(draft());
    h.evaluation.setReporting(false);
    h.setActual(0);
    expect(h.events).toEqual([]);
    h.evaluation.setReporting(true);
    expect(h.events.map((e) => [e.trigger, e.cleared])).toEqual([
      ["Alerting", false],
    ]);
  });

  it("restores a TargetDelta's triggered flag so its cleared event follows (N07.FR.14)", () => {
    const store = new MonitoringStore();
    store.restore([
      {
        id: 4,
        type: "TargetDelta",
        severity: 5,
        value: 100,
        transaction: false,
        component: { name: "EVSE", evse: { id: 1 } },
        variable: { name: "Power" },
        valueKey: "EVSEPower1",
        origin: "CustomMonitor",
      },
    ]);
    const events: MonitoringEvent[] = [];
    const evaluation = new MonitorEvaluation(
      {
        store,
        read: () => reading(7400, 7400),
        emit: (batch) => events.push(...batch),
        transactionActive: () => false,
      },
      new Map([[4, true]]),
    );
    expect(evaluation.isTriggered(4)).toBe(true);
    evaluation.setReporting(false);
    evaluation.setReporting(true);
    expect(events.map((e) => [e.monitor.id, e.cleared])).toEqual([[4, true]]);
  });
});

describe("DeviceModelTargets", () => {
  it("holds a target per declared key, tells listeners of real changes only", () => {
    const targets = new DeviceModelTargets();
    const changes: string[] = [];
    targets.onChange((key) => changes.push(key));
    expect(targets.supports("EVSEPower1")).toBe(false);
    targets.declare("EVSEPower1");
    expect(targets.supports("EVSEPower1")).toBe(true);
    expect(targets.get("EVSEPower1")).toBeUndefined();
    targets.set("EVSEPower1", 7000);
    targets.set("EVSEPower1", 7000);
    expect(targets.get("EVSEPower1")).toBe(7000);
    expect(changes).toEqual(["EVSEPower1"]);
    expect(() => targets.set("HeartbeatInterval", 1)).toThrow();
  });
});
