import { describe, expect, it } from "vitest";
import { DEFAULT_MONITOR_CATALOG } from "../monitorCatalog";
import {
  MonitoringStore,
  type MonitorDraft,
  type MonitoringStoreEvent,
} from "../MonitoringStore";
import type { VariableMonitor } from "../VariableMonitor";

/**
 * #538: hardwired and preconfigured monitors (N03, N04.FR.15, FR.18,
 * N06.FR.03) on top of the custom ones.
 */

const HARDWIRED: VariableMonitor = {
  id: 900,
  type: "Delta",
  severity: 1,
  value: 1,
  transaction: false,
  component: { name: "MonitoringCtrlr" },
  variable: { name: "ItemsPerMessage", instance: "SetVariableMonitoring" },
  valueKey: "ItemsPerMessageSetVariableMonitoring",
  origin: "HardWiredMonitor",
};
const PRECONFIGURED: VariableMonitor = {
  ...HARDWIRED,
  id: 901,
  severity: 5,
  variable: { name: "BytesPerMessage", instance: "SetVariableMonitoring" },
  valueKey: "BytesPerMessageSetVariableMonitoring",
  origin: "PreconfiguredMonitor",
};
const CATALOG = [HARDWIRED, PRECONFIGURED];

function custom(overrides: Partial<MonitorDraft> = {}): MonitorDraft {
  return {
    type: "UpperThreshold",
    severity: 4,
    value: 600,
    component: { name: "OCPPCommCtrlr" },
    variable: { name: "HeartbeatInterval" },
    valueKey: "HeartbeatInterval",
    valueType: { numeric: true },
    ...overrides,
  };
}

/** A store whose catalog is active, as on a station's first start. */
function fresh(): MonitoringStore {
  const store = new MonitoringStore(CATALOG);
  store.initialize([], undefined);
  return store;
}

function recorded(store: MonitoringStore): MonitoringStoreEvent[] {
  const events: MonitoringStoreEvent[] = [];
  store.onChange((e) => events.push(e));
  return events;
}

const ids = (store: MonitoringStore) => store.list().map((m) => m.id);

describe("MonitoringStore catalog (#538)", () => {
  it("starts with the hardwired and preconfigured monitors, base All", () => {
    const store = fresh();
    expect(store.list()).toEqual([HARDWIRED, PRECONFIGURED]);
    expect(store.activeMonitoringBase).toBe("All");
  });

  it("allocates custom ids from 1, skipping catalog ids (N04.FR.11)", () => {
    const store = new MonitoringStore([{ ...HARDWIRED, id: 2 }]);
    store.initialize([], undefined);
    const first = store.install(custom());
    const second = store.install(custom({ severity: 5 }));
    expect(
      [first, second].map((o) => o.status === "Accepted" && o.monitor.id),
    ).toEqual([1, 3]);
  });

  it("a catalog without a persisted base is left to the persisted monitors' ids", () => {
    // A v21 database: custom monitor 1, no catalog state yet.
    const store = new MonitoringStore(CATALOG);
    const persisted: VariableMonitor = {
      ...PRECONFIGURED,
      id: 1,
      origin: "CustomMonitor",
    };
    store.initialize([persisted], undefined);
    expect(store.list()).toEqual([persisted, HARDWIRED, PRECONFIGURED]);
    const next = store.install(custom());
    expect(next.status === "Accepted" && next.monitor.id).toBe(2);
  });

  it("restores a persisted base: the preconfigured monitors are the persisted ones", () => {
    const store = new MonitoringStore(CATALOG);
    store.initialize([], "HardWiredOnly");
    expect(store.list()).toEqual([HARDWIRED]);
    expect(store.activeMonitoringBase).toBe("HardWiredOnly");
  });

  it("a persisted replacement of a preconfigured monitor wins over the catalog entry", () => {
    const store = new MonitoringStore(CATALOG);
    const replaced: VariableMonitor = {
      ...PRECONFIGURED,
      value: 7,
      origin: "CustomMonitor",
    };
    store.initialize([replaced], "All");
    expect(store.get(PRECONFIGURED.id)).toEqual(replaced);
  });

  it("the hardwired monitors always come from the catalog", () => {
    const store = new MonitoringStore(CATALOG);
    store.initialize([{ ...HARDWIRED, value: 99 }], "All");
    expect(store.get(HARDWIRED.id)).toEqual(HARDWIRED);
  });

  it("ignores a persisted hardwired monitor the catalog no longer has", () => {
    const store = new MonitoringStore(CATALOG);
    const stale: VariableMonitor = { ...HARDWIRED, id: 950 };
    const kept: VariableMonitor = {
      ...PRECONFIGURED,
      id: 951,
      origin: "CustomMonitor",
    };
    store.initialize([stale, kept], "All");
    expect(store.get(stale.id)).toBeUndefined();
    expect(store.get(kept.id)).toEqual(kept);
    // Nothing undeletable is left behind.
    expect(store.list().filter((m) => m.origin === "HardWiredMonitor")).toEqual(
      [HARDWIRED],
    );
  });

  it("refuses to clear (N06.FR.03) or replace (N04.FR.18) a hardwired monitor", () => {
    const store = fresh();
    expect(store.clear(HARDWIRED.id)).toBe("Rejected");
    expect(
      store.install(
        custom({
          id: HARDWIRED.id,
          type: "Delta",
          value: 2,
          component: HARDWIRED.component,
          variable: HARDWIRED.variable,
          valueKey: HARDWIRED.valueKey,
        }),
      ),
    ).toEqual({ status: "Rejected", reason: "HardWiredMonitor" });
    expect(store.get(HARDWIRED.id)).toEqual(HARDWIRED);
  });

  it("a replaced preconfigured monitor keeps its id and becomes custom (N04.FR.12, FR.15)", () => {
    const store = fresh();
    const outcome = store.install(
      custom({
        id: PRECONFIGURED.id,
        type: "Delta",
        value: 2,
        component: PRECONFIGURED.component,
        variable: PRECONFIGURED.variable,
        valueKey: PRECONFIGURED.valueKey,
      }),
    );
    expect(outcome.status).toBe("Accepted");
    expect(store.get(PRECONFIGURED.id)).toMatchObject({
      value: 2,
      origin: "CustomMonitor",
    });
  });

  it("clears a preconfigured monitor (N06.FR.01)", () => {
    const store = fresh();
    expect(store.clear(PRECONFIGURED.id)).toBe("Accepted");
    expect(ids(store)).toEqual([HARDWIRED.id]);
  });

  describe("SetMonitoringBase (N03)", () => {
    function withChanges(): MonitoringStore {
      const store = fresh();
      store.install(custom()); // id 1
      // The preconfigured monitor, replaced: now custom (N04.FR.15).
      store.install(
        custom({
          id: PRECONFIGURED.id,
          type: "Delta",
          value: 2,
          component: PRECONFIGURED.component,
          variable: PRECONFIGURED.variable,
          valueKey: PRECONFIGURED.valueKey,
        }),
      );
      return store;
    }

    it("All re-activates the preconfigured monitors and keeps every custom one, changed ones included (N03.FR.03)", () => {
      const store = fresh();
      store.install(custom()); // id 1
      store.clear(PRECONFIGURED.id);
      const events = recorded(store);

      expect(store.applyMonitoringBase("All")).toBe("Accepted");
      expect(store.list()).toEqual([
        expect.objectContaining({ id: 1, origin: "CustomMonitor" }),
        HARDWIRED,
        PRECONFIGURED,
      ]);
      expect(events).toEqual([
        { kind: "installed", monitor: PRECONFIGURED },
        { kind: "baseChanged", base: "All" },
      ]);

      const changed = withChanges();
      changed.applyMonitoringBase("All");
      expect(changed.get(PRECONFIGURED.id)).toMatchObject({
        value: 2,
        origin: "CustomMonitor",
      });
    });

    it("FactoryDefault deletes every custom monitor, then restores the preconfigured ones under their ids (N03.FR.04)", () => {
      const store = withChanges();
      const events = recorded(store);

      expect(store.applyMonitoringBase("FactoryDefault")).toBe("Accepted");
      expect(store.list()).toEqual([HARDWIRED, PRECONFIGURED]);
      expect(
        events.map((e) => [e.kind, "monitor" in e && e.monitor.id]),
      ).toEqual([
        ["cleared", 1],
        ["cleared", PRECONFIGURED.id],
        ["installed", PRECONFIGURED.id],
        ["baseChanged", false],
      ]);
      expect(store.activeMonitoringBase).toBe("FactoryDefault");
    });

    it("HardWiredOnly deletes the custom and the preconfigured monitors (N03.FR.05)", () => {
      const store = withChanges();
      store.applyMonitoringBase("FactoryDefault");
      expect(store.applyMonitoringBase("HardWiredOnly")).toBe("Accepted");
      expect(store.list()).toEqual([HARDWIRED]);
      expect(store.activeMonitoringBase).toBe("HardWiredOnly");
    });

    it("All after HardWiredOnly restores a preconfigured monitor next to a custom duplicate of it (N03.FR.03; N04.FR.10 not applied)", () => {
      const store = fresh();
      store.applyMonitoringBase("HardWiredOnly");
      // The same type, severity and target as the preconfigured monitor:
      // not a Duplicate now that the preconfigured one is deleted.
      const twin = store.install(
        custom({
          type: PRECONFIGURED.type,
          severity: PRECONFIGURED.severity,
          value: PRECONFIGURED.value,
          component: PRECONFIGURED.component,
          variable: PRECONFIGURED.variable,
          valueKey: PRECONFIGURED.valueKey,
        }),
      );
      expect(twin.status).toBe("Accepted");

      store.applyMonitoringBase("All");
      const sameTarget = store
        .list()
        .filter((m) => m.valueKey === PRECONFIGURED.valueKey);
      expect(sameTarget.map((m) => [m.origin, m.type, m.severity])).toEqual([
        ["CustomMonitor", "Delta", 5],
        ["PreconfiguredMonitor", "Delta", 5],
      ]);
    });

    it("keeps the base on an unknown value (N03.FR.02)", () => {
      const store = fresh();
      expect(store.applyMonitoringBase("Everything")).toBe("NotSupported");
      expect(store.activeMonitoringBase).toBe("All");
    });
  });
});

describe("DEFAULT_MONITOR_CATALOG", () => {
  it("holds hardwired and preconfigured monitors with distinct ids above custom ones", () => {
    const origins = new Set(DEFAULT_MONITOR_CATALOG.map((m) => m.origin));
    expect(origins).toEqual(
      new Set(["HardWiredMonitor", "PreconfiguredMonitor"]),
    );
    const catalogIds = DEFAULT_MONITOR_CATALOG.map((m) => m.id);
    expect(new Set(catalogIds).size).toBe(catalogIds.length);
    expect(Math.min(...catalogIds)).toBeGreaterThan(1000);
  });
});
