import { describe, expect, it } from "vitest";
import {
  MonitoringStore,
  type MonitorDraft,
  type MonitoringStoreEvent,
} from "../MonitoringStore";
import { selectMonitors } from "../selectMonitors";

const INTEGER_0_TO_100 = { numeric: true, min: 0, max: 100 } as const;
const BOOLEAN = { numeric: false } as const;

function draft(overrides: Partial<MonitorDraft> = {}): MonitorDraft {
  return {
    type: "UpperThreshold",
    severity: 5,
    value: 50,
    component: { name: "OCPPCommCtrlr" },
    variable: { name: "HeartbeatInterval" },
    valueKey: "HeartbeatInterval",
    valueType: INTEGER_0_TO_100,
    ...overrides,
  };
}

describe("MonitoringStore.install", () => {
  it.each(["UpperThreshold", "LowerThreshold", "Delta"] as const)(
    "creates a custom %s monitor with a generated id (N04.FR.08, N04.FR.11)",
    (type) => {
      const store = new MonitoringStore();
      const outcome = store.install(draft({ type }));

      expect(outcome).toMatchObject({ status: "Accepted" });
      if (outcome.status !== "Accepted") throw new Error("unreachable");
      expect(outcome.monitor).toEqual({
        id: 1,
        type,
        severity: 5,
        value: 50,
        transaction: false,
        component: { name: "OCPPCommCtrlr" },
        variable: { name: "HeartbeatInterval" },
        valueKey: "HeartbeatInterval",
        origin: "CustomMonitor",
      });
      expect(store.get(1)).toEqual(outcome.monitor);
    },
  );

  it("allocates increasing ids and never reuses a cleared one", () => {
    const store = new MonitoringStore();
    store.install(draft({ severity: 1 }));
    store.install(draft({ severity: 2 }));
    expect(store.clear(2)).toBe("Accepted");

    const third = store.install(draft({ severity: 3 }));
    expect(third).toMatchObject({ status: "Accepted", monitor: { id: 3 } });
  });

  it("keeps the transaction flag", () => {
    const store = new MonitoringStore();
    expect(store.install(draft({ transaction: true }))).toMatchObject({
      status: "Accepted",
      monitor: { transaction: true },
    });
  });

  it("returns Duplicate for the same type and severity on the same target (N04.FR.10)", () => {
    const store = new MonitoringStore();
    store.install(draft({ value: 60 }));

    expect(store.install(draft({ value: 70 }))).toMatchObject({
      status: "Duplicate",
    });
    expect(store.list()).toHaveLength(1);
  });

  it("accepts a different severity, type or target next to an existing monitor", () => {
    const store = new MonitoringStore();
    store.install(draft());

    expect(store.install(draft({ severity: 4 })).status).toBe("Accepted");
    expect(store.install(draft({ type: "LowerThreshold" })).status).toBe(
      "Accepted",
    );
    expect(
      store.install(
        draft({ component: { name: "OCPPCommCtrlr", instance: "B" } }),
      ).status,
    ).toBe("Accepted");
    expect(
      store.install(
        draft({
          component: { name: "OCPPCommCtrlr", evse: { id: 1 } },
        }),
      ).status,
    ).toBe("Accepted");
  });

  it("replaces the monitor of a known id on the same target (N04.FR.12)", () => {
    const store = new MonitoringStore();
    store.install(draft({ value: 60 }));

    const outcome = store.install(draft({ id: 1, value: 80, severity: 2 }));

    expect(outcome).toMatchObject({
      status: "Accepted",
      monitor: { id: 1, value: 80, severity: 2 },
      replaced: { id: 1, value: 60, severity: 5 },
    });
    expect(store.list()).toHaveLength(1);
  });

  it("does not count the replaced monitor as its own duplicate", () => {
    const store = new MonitoringStore();
    store.install(draft({ value: 60 }));

    expect(store.install(draft({ id: 1, value: 61 })).status).toBe("Accepted");
  });

  it("returns Duplicate when a replace collides with another monitor", () => {
    const store = new MonitoringStore();
    store.install(draft({ severity: 1 }));
    store.install(draft({ severity: 2 }));

    expect(store.install(draft({ id: 2, severity: 1 })).status).toBe(
      "Duplicate",
    );
    expect(store.get(2)?.severity).toBe(2);
  });

  it("rejects an unknown id (N04.FR.13)", () => {
    const store = new MonitoringStore();
    expect(store.install(draft({ id: 7 }))).toEqual({
      status: "Rejected",
      reason: "UnknownMonitorId",
    });
    expect(store.list()).toHaveLength(0);
  });

  it("rejects a replace that changes the component or variable (N04.FR.16)", () => {
    const store = new MonitoringStore();
    store.install(draft());

    expect(
      store.install(
        draft({
          id: 1,
          variable: { name: "WebSocketPingInterval" },
          valueKey: "WebSocketPingInterval",
        }),
      ),
    ).toEqual({ status: "Rejected", reason: "TargetMismatch" });
    expect(store.get(1)?.variable).toEqual({ name: "HeartbeatInterval" });
  });

  it.each(["Periodic", "PeriodicClockAligned", "TargetDelta", "Bogus"])(
    "returns UnsupportedMonitorType for %s (N04.FR.05)",
    (type) => {
      const store = new MonitoringStore();
      expect(store.install(draft({ type })).status).toBe(
        "UnsupportedMonitorType",
      );
    },
  );

  it.each(["UpperThreshold", "LowerThreshold"])(
    "returns UnsupportedMonitorType for %s on a non-numeric variable (N04.FR.05)",
    (type) => {
      const store = new MonitoringStore();
      expect(
        store.install(draft({ type, value: 1, valueType: BOOLEAN })).status,
      ).toBe("UnsupportedMonitorType");
    },
  );

  it("accepts Delta on a non-numeric variable (N04.FR.17, N07.FR.19)", () => {
    const store = new MonitoringStore();
    expect(
      store.install(draft({ type: "Delta", value: 1, valueType: BOOLEAN }))
        .status,
    ).toBe("Accepted");
  });

  it.each([
    ["UpperThreshold", -1],
    ["UpperThreshold", 101],
    ["LowerThreshold", -1],
    ["LowerThreshold", 101],
  ])("rejects %s %d outside the variable range (N04.FR.06)", (type, value) => {
    const store = new MonitoringStore();
    expect(store.install(draft({ type, value }))).toEqual({
      status: "Rejected",
      reason: "ValueOutOfRange",
    });
  });

  it("accepts thresholds on the range bounds", () => {
    const store = new MonitoringStore();
    expect(store.install(draft({ value: 0, severity: 1 })).status).toBe(
      "Accepted",
    );
    expect(store.install(draft({ value: 100, severity: 2 })).status).toBe(
      "Accepted",
    );
  });

  it("rejects a negative Delta (N04.FR.14)", () => {
    const store = new MonitoringStore();
    expect(store.install(draft({ type: "Delta", value: -0.5 }))).toEqual({
      status: "Rejected",
      reason: "NegativeDelta",
    });
  });

  it("does not range-check a Delta value against the variable bounds", () => {
    const store = new MonitoringStore();
    expect(store.install(draft({ type: "Delta", value: 500 })).status).toBe(
      "Accepted",
    );
  });

  it.each([-1, 10, 1.5])("rejects severity %d outside 0-9", (severity) => {
    const store = new MonitoringStore();
    expect(store.install(draft({ severity }))).toEqual({
      status: "Rejected",
      reason: "SeverityOutOfRange",
    });
  });
});

describe("MonitoringStore.clear", () => {
  it("removes a custom monitor (N06.FR.01) and reports unknown ids as NotFound (N06.FR.02)", () => {
    const store = new MonitoringStore();
    store.install(draft());

    expect(store.clear(1)).toBe("Accepted");
    expect(store.get(1)).toBeUndefined();
    expect(store.clear(1)).toBe("NotFound");
    expect(store.clear(42)).toBe("NotFound");
  });
});

describe("MonitoringStore queries", () => {
  it("lists monitors by id and finds them by device-model value key", () => {
    const store = new MonitoringStore();
    store.install(draft({ severity: 1 }));
    store.install(
      draft({
        variable: { name: "WebSocketPingInterval" },
        valueKey: "WebSocketPingInterval",
      }),
    );
    store.install(draft({ severity: 2, type: "Delta" }));

    expect(store.list().map((m) => m.id)).toEqual([1, 2, 3]);
    expect(store.byValueKey("HeartbeatInterval").map((m) => m.id)).toEqual([
      1, 3,
    ]);
    expect(store.byValueKey("Unknown")).toEqual([]);
  });
});

describe("MonitoringStore monitoring level", () => {
  it("defaults to 9 so every severity is reported until the CSMS narrows it", () => {
    expect(new MonitoringStore().monitoringLevel).toBe(9);
  });

  it.each([0, 4, 9])("accepts level %d (N05.FR.01)", (level) => {
    const store = new MonitoringStore();
    expect(store.setMonitoringLevel(level)).toBe(true);
    expect(store.monitoringLevel).toBe(level);
  });

  it.each([-1, 10, 2.5])(
    "refuses level %d and keeps the previous one (N05.FR.02)",
    (level) => {
      const store = new MonitoringStore();
      store.setMonitoringLevel(3);
      expect(store.setMonitoringLevel(level)).toBe(false);
      expect(store.monitoringLevel).toBe(3);
    },
  );
});

describe("MonitoringStore.onChange", () => {
  it("tells listeners about installs, replaces, clears and level changes", () => {
    const store = new MonitoringStore();
    const events: MonitoringStoreEvent[] = [];
    const off = store.onChange((e) => events.push(e));

    store.install(draft({ value: 60 }));
    store.install(draft({ id: 1, value: 70 }));
    store.install(draft({ id: 99 }));
    store.clear(1);
    store.clear(1);
    store.setMonitoringLevel(4);
    store.setMonitoringLevel(12);
    off();
    store.install(draft());

    expect(events.map((e) => e.kind)).toEqual([
      "installed",
      "installed",
      "cleared",
      "levelChanged",
    ]);
    expect(events[1]).toMatchObject({
      kind: "installed",
      monitor: { id: 1, value: 70 },
      replaced: { id: 1, value: 60 },
    });
    expect(events[3]).toEqual({ kind: "levelChanged", level: 4 });
  });
});

describe("selectMonitors", () => {
  function seeded(): MonitoringStore {
    const store = new MonitoringStore();
    store.install(draft({ type: "UpperThreshold" }));
    store.install(draft({ type: "LowerThreshold" }));
    store.install(draft({ type: "Delta" }));
    store.install(
      draft({
        type: "Delta",
        component: { name: "TxCtrlr" },
        variable: { name: "EVConnectionTimeOut" },
        valueKey: "ConnectionTimeOut",
      }),
    );
    store.install(
      draft({
        type: "Delta",
        component: { name: "TxCtrlr", evse: { id: 1, connectorId: 2 } },
        variable: { name: "EVConnectionTimeOut", instance: "x" },
        valueKey: "ConnectionTimeOut",
      }),
    );
    return store;
  }

  it("returns every monitor without filters (N02.FR.11)", () => {
    expect(selectMonitors(seeded().list(), {}).map((m) => m.id)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("filters by monitor type (N02.FR.06, N02.FR.12, N02.FR.13)", () => {
    const monitors = seeded().list();
    expect(
      selectMonitors(monitors, {
        types: new Set(["UpperThreshold", "LowerThreshold"]),
      }).map((m) => m.id),
    ).toEqual([1, 2]);
    expect(
      selectMonitors(monitors, { types: new Set(["Delta"]) }).map((m) => m.id),
    ).toEqual([3, 4, 5]);
  });

  it("filters by component, treating missing fields as wildcards (N02.FR.08, N02.FR.16-21)", () => {
    const monitors = seeded().list();
    const ids = (targets: Parameters<typeof selectMonitors>[1]["targets"]) =>
      selectMonitors(monitors, { targets }).map((m) => m.id);

    expect(ids([{ component: { name: "TxCtrlr" } }])).toEqual([4, 5]);
    expect(
      ids([
        {
          component: { name: "TxCtrlr" },
          variable: { name: "EVConnectionTimeOut" },
        },
      ]),
    ).toEqual([4, 5]);
    expect(
      ids([
        {
          component: { name: "TxCtrlr" },
          variable: { name: "EVConnectionTimeOut", instance: "x" },
        },
      ]),
    ).toEqual([5]);
    expect(ids([{ component: { name: "TxCtrlr", evse: { id: 1 } } }])).toEqual([
      5,
    ]);
    expect(
      ids([
        { component: { name: "TxCtrlr", evse: { id: 1, connectorId: 1 } } },
      ]),
    ).toEqual([]);
    expect(
      ids([{ component: { name: "TxCtrlr", instance: "other" } }]),
    ).toEqual([]);
    expect(
      ids([
        {
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "WebSocketPingInterval" },
        },
      ]),
    ).toEqual([]);
  });

  it("combines type and target filters (N02.FR.05)", () => {
    expect(
      selectMonitors(seeded().list(), {
        types: new Set(["Delta"]),
        targets: [{ component: { name: "OCPPCommCtrlr" } }],
      }).map((m) => m.id),
    ).toEqual([3]);
  });
});
