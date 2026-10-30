import { describe, expect, it } from "vitest";
import type {
  GetMonitoringReportRequestV201,
  NotifyMonitoringReportRequestV21,
  SetVariableMonitoringRequestV201,
} from "../../../../../ocpp";
import {
  isValidClearVariableMonitoringResponseV201,
  isValidGetMonitoringReportResponseV201,
  isValidNotifyMonitoringReportRequestV201,
  isValidSetMonitoringLevelResponseV201,
  isValidSetVariableMonitoringResponseV201,
} from "../../../../../ocpp/v201";
import {
  isValidClearVariableMonitoringResponseV21,
  isValidNotifyMonitoringReportRequestV21,
  isValidSetMonitoringLevelResponseV21,
  isValidSetVariableMonitoringRequestV21,
  isValidSetVariableMonitoringResponseV21,
} from "../../../../../ocpp/v21";
import {
  ConfigurationKeys,
  ConfigurationStore,
  type ConfigurationValue,
} from "../../../../domain/charge-point/ConfigurationStore";
import { MonitoringStore } from "../../../../domain/monitoring/MonitoringStore";
import {
  buildMonitoringReportV201,
  handleClearVariableMonitoringV201,
  handleSetMonitoringLevelV201,
  handleSetVariableMonitoringV201,
} from "../variableMonitoringV201";

type MonitoringData = SetVariableMonitoringRequestV201["setMonitoringData"][0];

function config(): ConfigurationStore {
  const entries: ConfigurationValue[] = [
    { key: ConfigurationKeys.Core.HeartbeatInterval, value: 300 },
    { key: ConfigurationKeys.Core.ClockAlignedDataInterval, value: 0 },
    { key: ConfigurationKeys.Core.WebSocketPingInterval, value: 0 },
    { key: ConfigurationKeys.Core.TransactionMessageAttempts, value: 3 },
    {
      key: ConfigurationKeys.LocalAuthListManagement.LocalAuthListEnabled,
      value: true,
    },
  ];
  return new ConfigurationStore("cp-monitoring", entries, null);
}

function heartbeat(overrides: Partial<MonitoringData> = {}): MonitoringData {
  return {
    value: 600,
    type: "UpperThreshold",
    severity: 5,
    component: { name: "OCPPCommCtrlr" },
    variable: { name: "HeartbeatInterval" },
    ...overrides,
  };
}

function set(
  store: MonitoringStore,
  ...items: MonitoringData[]
): ReturnType<typeof handleSetVariableMonitoringV201> {
  const response = handleSetVariableMonitoringV201(
    { setMonitoringData: items as [MonitoringData, ...MonitoringData[]] },
    store,
    config(),
    () => true,
  );
  expect(isValidSetVariableMonitoringResponseV201(response)).toBe(true);
  expect(isValidSetVariableMonitoringResponseV21(response)).toBe(true);
  return response;
}

describe("handleSetVariableMonitoringV201", () => {
  it.each(["UpperThreshold", "LowerThreshold", "Delta"] as const)(
    "creates a %s monitor and returns its id (N04.FR.08, N04.FR.11)",
    (type) => {
      const store = new MonitoringStore();
      const response = set(store, heartbeat({ type }));

      expect(response.setMonitoringResult).toEqual([
        {
          id: 1,
          status: "Accepted",
          type,
          severity: 5,
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "HeartbeatInterval" },
        },
      ]);
      expect(store.get(1)).toMatchObject({
        type,
        value: 600,
        valueKey: "HeartbeatInterval",
        origin: "CustomMonitor",
      });
    },
  );

  it("answers one result per item, in order (N04.FR.01, N04.FR.02)", () => {
    const store = new MonitoringStore();
    const response = set(
      store,
      heartbeat(),
      heartbeat({ value: 700 }),
      heartbeat({
        component: { name: "NoSuchCtrlr" },
      }),
      heartbeat({
        variable: { name: "NoSuchVariable" },
      }),
    );

    expect(
      response.setMonitoringResult.map((r) => [
        r.status,
        r.component.name,
        r.variable.name,
      ]),
    ).toEqual([
      ["Accepted", "OCPPCommCtrlr", "HeartbeatInterval"],
      ["Duplicate", "OCPPCommCtrlr", "HeartbeatInterval"],
      ["UnknownComponent", "NoSuchCtrlr", "HeartbeatInterval"],
      ["UnknownVariable", "OCPPCommCtrlr", "NoSuchVariable"],
    ]);
    expect(store.list()).toHaveLength(1);
  });

  it("resolves the variable through the Get/SetVariables device-model map", () => {
    const store = new MonitoringStore();
    const response = set(
      store,
      heartbeat({
        type: "Delta",
        value: 1,
        component: { name: "LocalAuthListCtrlr" },
        variable: { name: "Enabled" },
      }),
    );

    expect(response.setMonitoringResult[0].status).toBe("Accepted");
    expect(store.get(1)?.valueKey).toBe("LocalAuthListEnabled");
  });

  it("resolves an instanced variable with its instance only (#538)", () => {
    const store = new MonitoringStore();
    const attempts = {
      type: "Delta" as const,
      value: 1,
      component: { name: "OCPPCommCtrlr" },
    };
    const [withInstance, withoutInstance] = set(
      store,
      heartbeat({
        ...attempts,
        variable: { name: "MessageAttempts", instance: "TransactionEvent" },
      }),
      heartbeat({ ...attempts, variable: { name: "MessageAttempts" } }),
    ).setMonitoringResult;

    expect(withInstance).toMatchObject({ id: 1, status: "Accepted" });
    expect(store.get(1)?.valueKey).toBe("TransactionMessageAttempts");
    expect(withoutInstance.status).toBe("UnknownVariable"); // N04.FR.04
  });

  it.each([
    [{ id: 2 }, "UnknownComponent"],
    [{ id: 0 }, "UnknownComponent"],
    [{ id: 1, connectorId: 2 }, "UnknownComponent"],
    [{ id: 1 }, "Accepted"],
    [{ id: 1, connectorId: 1 }, "Accepted"],
  ])(
    "answers %j on a one-EVSE station with %s (N04.FR.03, #538)",
    (evse, status) => {
      const store = new MonitoringStore();
      const response = handleSetVariableMonitoringV201(
        {
          setMonitoringData: [
            heartbeat({ component: { name: "OCPPCommCtrlr", evse } }),
          ],
        },
        store,
        config(),
        (e) => e.id === 1 && (e.connectorId ?? 1) === 1,
      );
      expect(isValidSetVariableMonitoringResponseV201(response)).toBe(true);
      expect(response.setMonitoringResult[0].status).toBe(status);
    },
  );

  it.each(["Periodic", "PeriodicClockAligned"] as const)(
    "accepts a %s monitor, its value an interval in seconds (N08, #538)",
    (type) => {
      const store = new MonitoringStore();
      expect(
        set(store, heartbeat({ type, value: 900 })).setMonitoringResult[0],
      ).toEqual({
        id: 1,
        status: "Accepted",
        type,
        severity: 5,
        component: { name: "OCPPCommCtrlr" },
        variable: { name: "HeartbeatInterval" },
      });
      expect(store.get(1)).toMatchObject({ type, value: 900 });
    },
  );

  it("rejects a Periodic interval under one second (IntervalTooShort, #538)", () => {
    const store = new MonitoringStore();
    expect(
      set(store, heartbeat({ type: "Periodic", value: 0 }))
        .setMonitoringResult[0],
    ).toMatchObject({
      status: "Rejected",
      statusInfo: {
        reasonCode: "IntervalTooShort",
        additionalInfo: "a Periodic interval is at least 1 second",
      },
    });
    expect(store.list()).toEqual([]);
  });

  it("answers UnsupportedMonitorType for the 2.1 TargetDelta types (N04.FR.05)", () => {
    const store = new MonitoringStore();
    const request = {
      setMonitoringData: [
        heartbeat({ type: "TargetDelta" as MonitoringData["type"] }),
        heartbeat({ type: "TargetDeltaRelative" as MonitoringData["type"] }),
      ],
    };
    expect(isValidSetVariableMonitoringRequestV21(request)).toBe(true);

    const response = handleSetVariableMonitoringV201(
      request as SetVariableMonitoringRequestV201,
      store,
      config(),
      () => true,
    );
    expect(isValidSetVariableMonitoringResponseV21(response)).toBe(true);
    expect(response.setMonitoringResult.map((r) => r.status)).toEqual([
      "UnsupportedMonitorType",
      "UnsupportedMonitorType",
    ]);
  });

  it("answers UnsupportedMonitorType for a threshold on a boolean variable (N04.FR.05)", () => {
    const store = new MonitoringStore();
    const response = set(
      store,
      heartbeat({
        value: 1,
        component: { name: "LocalAuthListCtrlr" },
        variable: { name: "Enabled" },
      }),
    );
    expect(response.setMonitoringResult[0].status).toBe(
      "UnsupportedMonitorType",
    );
  });

  it.each([
    ["a threshold outside the variable range (N04.FR.06)", 86401, "Upper"],
    ["a negative Delta (N04.FR.14)", -1, "Delta"],
  ] as const)("rejects %s with a statusInfo", (_label, value, kind) => {
    const store = new MonitoringStore();
    const response = set(
      store,
      heartbeat({
        value,
        type: kind === "Upper" ? "UpperThreshold" : "Delta",
        component: { name: "AlignedDataCtrlr" },
        variable: { name: "Interval" },
      }),
    );
    const [result] = response.setMonitoringResult;
    expect(result.status).toBe("Rejected");
    expect(result.statusInfo?.reasonCode).toBe(
      kind === "Upper" ? "ValueOutOfRange" : "NegativeDelta",
    );
  });

  it("rejects a severity above 9", () => {
    const store = new MonitoringStore();
    const [result] = set(
      store,
      heartbeat({ severity: 10 }),
    ).setMonitoringResult;
    expect(result.status).toBe("Rejected");
    expect(result.statusInfo?.reasonCode).toBe("SeverityOutOfRange");
  });

  it("rejects an unknown id (N04.FR.13) and replaces a known one (N04.FR.12)", () => {
    const store = new MonitoringStore();
    set(store, heartbeat());

    const [unknown] = set(store, heartbeat({ id: 9 })).setMonitoringResult;
    expect(unknown).toMatchObject({
      status: "Rejected",
      statusInfo: { reasonCode: "UnknownMonitorId" },
    });

    const [replaced] = set(
      store,
      heartbeat({ id: 1, value: 900 }),
    ).setMonitoringResult;
    expect(replaced).toMatchObject({ id: 1, status: "Accepted" });
    expect(store.get(1)?.value).toBe(900);
  });

  it("rejects a replace that moves the monitor to another variable (N04.FR.16)", () => {
    const store = new MonitoringStore();
    set(store, heartbeat());

    const [result] = set(
      store,
      heartbeat({
        id: 1,
        component: { name: "OCPPCommCtrlr" },
        variable: { name: "WebSocketPingInterval" },
      }),
    ).setMonitoringResult;
    expect(result).toMatchObject({
      status: "Rejected",
      statusInfo: { reasonCode: "TargetMismatch" },
    });
    expect(store.get(1)?.variable.name).toBe("HeartbeatInterval");
  });
});

describe("handleClearVariableMonitoringV201", () => {
  it("clears known ids and reports unknown ones per id (N06.FR.01, N06.FR.02, N06.FR.05)", () => {
    const store = new MonitoringStore();
    set(store, heartbeat());

    const response = handleClearVariableMonitoringV201(
      { id: [1, 2, 1] },
      store,
    );

    expect(isValidClearVariableMonitoringResponseV201(response)).toBe(true);
    expect(isValidClearVariableMonitoringResponseV21(response)).toBe(true);
    expect(response.clearMonitoringResult).toEqual([
      { id: 1, status: "Accepted" },
      { id: 2, status: "NotFound" },
      { id: 1, status: "NotFound" },
    ]);
    expect(store.list()).toEqual([]);
  });
});

describe("handleSetMonitoringLevelV201", () => {
  it.each([
    [0, "Accepted"],
    [9, "Accepted"],
    [10, "Rejected"],
  ] as const)(
    "answers severity %d with %s (N05.FR.01, N05.FR.02)",
    (severity, status) => {
      const store = new MonitoringStore();
      const response = handleSetMonitoringLevelV201({ severity }, store);

      expect(response).toEqual({ status });
      expect(isValidSetMonitoringLevelResponseV201(response)).toBe(true);
      expect(isValidSetMonitoringLevelResponseV21(response)).toBe(true);
      expect(store.monitoringLevel).toBe(status === "Accepted" ? severity : 9);
    },
  );
});

describe("buildMonitoringReportV201", () => {
  function seeded(): MonitoringStore {
    const store = new MonitoringStore();
    set(
      store,
      heartbeat({ type: "UpperThreshold" }),
      heartbeat({ type: "LowerThreshold", value: 60 }),
      heartbeat({ type: "Delta", value: 10, transaction: true }),
      heartbeat({
        type: "Delta",
        value: 1,
        component: { name: "LocalAuthListCtrlr" },
        variable: { name: "Enabled" },
      }),
    );
    return store;
  }

  function report(
    store: MonitoringStore,
    req: Partial<GetMonitoringReportRequestV201>,
    dialect: "v201" | "v21" = "v201",
    itemsPerPart?: number,
  ) {
    const result = buildMonitoringReportV201(
      { requestId: 7, ...req },
      store,
      dialect,
      itemsPerPart,
    );
    expect(isValidGetMonitoringReportResponseV201(result.response)).toBe(true);
    for (const part of result.reports) {
      if (dialect === "v201") {
        expect(isValidNotifyMonitoringReportRequestV201(part)).toBe(true);
      } else {
        expect(isValidNotifyMonitoringReportRequestV21(part)).toBe(true);
      }
    }
    if (itemsPerPart === undefined) {
      expect(result.reports.length).toBeLessThanOrEqual(1);
    }
    return { ...result, report: result.reports[0] };
  }

  for (const dialect of ["v201", "v21"] as const) {
    it(`${dialect}: splits the report into parts with increasing seqNo and tbc on all but the last (N02.FR.03, FR.04, FR.09, #538)`, () => {
      const { response, reports } = report(seeded(), {}, dialect, 1);

      expect(response).toEqual({ status: "Accepted" });
      expect(
        reports.map((r) => [r.requestId, r.seqNo, r.tbc, r.monitor?.length]),
      ).toEqual([
        [7, 0, true, 1],
        [7, 1, false, 1],
      ]);
      expect(reports.map((r) => r.monitor?.[0]?.component.name)).toEqual([
        "OCPPCommCtrlr",
        "LocalAuthListCtrlr",
      ]);
      expect(new Set(reports.map((r) => r.generatedAt)).size).toBe(1);
    });
  }

  it("reports every monitor, grouped per component/variable (N02.FR.03, FR.04, FR.09, FR.11)", () => {
    const { response, report: notify } = report(seeded(), {});

    expect(response).toEqual({ status: "Accepted" });
    expect(notify).toMatchObject({ requestId: 7, seqNo: 0, tbc: false });
    expect(notify?.monitor).toEqual([
      {
        component: { name: "OCPPCommCtrlr" },
        variable: { name: "HeartbeatInterval" },
        variableMonitoring: [
          {
            id: 1,
            transaction: false,
            value: 600,
            type: "UpperThreshold",
            severity: 5,
          },
          {
            id: 2,
            transaction: false,
            value: 60,
            type: "LowerThreshold",
            severity: 5,
          },
          { id: 3, transaction: true, value: 10, type: "Delta", severity: 5 },
        ],
      },
      {
        component: { name: "LocalAuthListCtrlr" },
        variable: { name: "Enabled" },
        variableMonitoring: [
          { id: 4, transaction: false, value: 1, type: "Delta", severity: 5 },
        ],
      },
    ]);
  });

  it("adds eventNotificationType on 2.1 (2.1 N02.FR.22)", () => {
    const notify = report(seeded(), {}, "v21").report as
      NotifyMonitoringReportRequestV21 | undefined;
    expect(
      notify?.monitor
        ?.flatMap((m) => m.variableMonitoring)
        .map((vm) => vm.eventNotificationType),
    ).toEqual([
      "CustomMonitor",
      "CustomMonitor",
      "CustomMonitor",
      "CustomMonitor",
    ]);
    // ...and the 2.0.1 dialect leaves it out (additionalProperties: false).
    const v201 = report(seeded(), {}, "v201").report;
    expect(JSON.stringify(v201)).not.toContain("eventNotificationType");
  });

  it("filters by monitoringCriteria (N02.FR.06, FR.12, FR.13)", () => {
    const store = seeded();
    const ids = (
      criteria: GetMonitoringReportRequestV201["monitoringCriteria"],
    ) =>
      report(store, { monitoringCriteria: criteria }).report?.monitor?.flatMap(
        (m) => m.variableMonitoring.map((v) => v.id),
      );

    expect(ids(["ThresholdMonitoring"])).toEqual([1, 2]);
    expect(ids(["DeltaMonitoring"])).toEqual([3, 4]);
    expect(ids(["ThresholdMonitoring", "PeriodicMonitoring"])).toEqual([1, 2]);
  });

  it("selects Periodic and PeriodicClockAligned monitors with PeriodicMonitoring (N02.FR.14, #538)", () => {
    const store = seeded();
    expect(
      report(store, { monitoringCriteria: ["PeriodicMonitoring"] }).response,
    ).toEqual({ status: "EmptyResultSet" });

    set(
      store,
      heartbeat({ type: "Periodic", value: 60 }),
      heartbeat({ type: "PeriodicClockAligned", value: 900 }),
    );
    const result = report(store, {
      monitoringCriteria: ["PeriodicMonitoring"],
    });
    expect(result.response).toEqual({ status: "Accepted" });
    expect(isValidNotifyMonitoringReportRequestV201(result.report)).toBe(true);
    expect(
      result.report?.monitor?.flatMap((m) =>
        m.variableMonitoring.map((v) => [v.id, v.type, v.value]),
      ),
    ).toEqual([
      [5, "Periodic", 60],
      [6, "PeriodicClockAligned", 900],
    ]);
  });

  it("filters by componentVariable (N02.FR.05, FR.08, FR.16)", () => {
    const store = seeded();
    const result = report(store, {
      componentVariable: [{ component: { name: "LocalAuthListCtrlr" } }],
    });
    expect(result.report?.monitor?.map((m) => m.component.name)).toEqual([
      "LocalAuthListCtrlr",
    ]);

    const both = report(store, {
      monitoringCriteria: ["ThresholdMonitoring"],
      componentVariable: [{ component: { name: "LocalAuthListCtrlr" } }],
    });
    expect(both.response).toEqual({ status: "EmptyResultSet" });
  });

  it("answers EmptyResultSet without any monitor (N02.FR.10)", () => {
    const result = report(new MonitoringStore(), {});
    expect(result.response).toEqual({ status: "EmptyResultSet" });
    expect(result.report).toBeUndefined();
  });
});
