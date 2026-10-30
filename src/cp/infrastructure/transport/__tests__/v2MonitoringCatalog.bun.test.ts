import { describe, expect, it } from "bun:test";
import {
  isValidClearVariableMonitoringResponseV201,
  isValidGetMonitoringReportResponseV201,
  isValidGetVariablesResponseV201,
  isValidNotifyMonitoringReportRequestV201,
  isValidSetMonitoringBaseResponseV201,
  isValidSetVariableMonitoringResponseV201,
} from "../../../../ocpp/v201";
import {
  isValidClearVariableMonitoringResponseV21,
  isValidGetMonitoringReportResponseV21,
  isValidGetVariablesResponseV21,
  isValidNotifyMonitoringReportRequestV21,
  isValidSetMonitoringBaseResponseV21,
  isValidSetVariableMonitoringResponseV21,
} from "../../../../ocpp/v21";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import { BunSqliteDatabase } from "../../../domain/persistence/BunSqliteDatabase";
import type { Database } from "../../../domain/persistence/Database";
import { DEFAULT_MONITOR_CATALOG } from "../../../domain/monitoring/monitorCatalog";

/**
 * #538: the station's hardwired and preconfigured monitors on the wire
 * (GetMonitoringReport, ClearVariableMonitoring, SetVariableMonitoring,
 * SetMonitoringBase, MonitoringCtrlr.ActiveMonitoringBase) and across a
 * restart on --state-db.
 */

type Validator = (data: unknown) => boolean;

const VERSIONS = [
  {
    version: "OCPP-2.0.1",
    report: isValidGetMonitoringReportResponseV201,
    notifyReport: isValidNotifyMonitoringReportRequestV201,
    clear: isValidClearVariableMonitoringResponseV201,
    set: isValidSetVariableMonitoringResponseV201,
    base: isValidSetMonitoringBaseResponseV201,
    getVariables: isValidGetVariablesResponseV201,
    v21: false,
  },
  {
    version: "OCPP-2.1",
    report: isValidGetMonitoringReportResponseV21,
    notifyReport: isValidNotifyMonitoringReportRequestV21,
    clear: isValidClearVariableMonitoringResponseV21,
    set: isValidSetVariableMonitoringResponseV21,
    base: isValidSetMonitoringBaseResponseV21,
    getVariables: isValidGetVariablesResponseV21,
    v21: true,
  },
] as const;

const [HARDWIRED, PRECONFIGURED, PRECONFIGURED_2] = DEFAULT_MONITOR_CATALOG;

function makeChargePoint(
  csms: MockCsms,
  id: string,
  version: string,
  database: Database | null = null,
): ChargePoint {
  const cp = new ChargePoint(
    id,
    DefaultBootNotification,
    1,
    csms.url,
    null,
    null,
    database,
    {},
    [],
    version,
    {},
  );
  cp.events.on("error", () => undefined);
  return cp;
}

async function bootAccepted(csms: MockCsms): Promise<void> {
  const boot = await csms.waitForCall("BootNotification");
  csms.replyCallResult(boot.messageId, {
    status: "Accepted",
    currentTime: "2026-10-30T00:00:00.000Z",
    interval: 300,
  });
  await csms.waitForFrame((f) => f[0] === 2 && f[2] === "StatusNotification");
}

async function call(
  csms: MockCsms,
  messageId: string,
  action: string,
  payload: unknown,
  valid: Validator,
): Promise<Record<string, unknown>> {
  csms.send([2, messageId, action, payload]);
  const frame = await csms.waitForFrame(
    (f: OcppFrame) => f[0] === 3 && f[1] === messageId,
  );
  const response = frame[2] as Record<string, unknown>;
  expect(valid(response)).toBe(true);
  return response;
}

interface ReportedMonitor {
  id: number;
  type: string;
  eventNotificationType?: string;
}

/** Replace `target` (same id, type, component and variable) with a new value. */
function replacement(target: (typeof DEFAULT_MONITOR_CATALOG)[number]) {
  return {
    id: target.id,
    value: 5,
    type: target.type,
    severity: target.severity,
    component: target.component,
    variable: target.variable,
  };
}

describe("OCPP 2.x hardwired and preconfigured monitors (#538)", () => {
  for (const v of VERSIONS) {
    it(`${v.version}: reports, protects and restores the station's own monitors`, async () => {
      const csms = startMockCsms();
      const cp = makeChargePoint(csms, `CP-CATALOG-${v.version}`, v.version);
      try {
        cp.connect();
        await bootAccepted(csms);

        // A fresh station reports its own monitors (N02.FR.11).
        expect(
          await call(
            csms,
            "gmr-1",
            "GetMonitoringReport",
            { requestId: 1 },
            v.report,
          ),
        ).toEqual({ status: "Accepted" });
        const notify = await csms.waitForCall("NotifyMonitoringReport");
        expect(v.notifyReport(notify.payload)).toBe(true);
        csms.replyCallResult(notify.messageId, {});
        const reported = (
          notify.payload as {
            monitor: { variableMonitoring: ReportedMonitor[] }[];
          }
        ).monitor.flatMap((m) => m.variableMonitoring);
        expect(reported.map((m) => [m.id, m.eventNotificationType])).toEqual([
          [HARDWIRED.id, v.v21 ? "HardWiredMonitor" : undefined],
          [PRECONFIGURED.id, v.v21 ? "PreconfiguredMonitor" : undefined],
          [PRECONFIGURED_2.id, v.v21 ? "PreconfiguredMonitor" : undefined],
        ]);

        // N06.FR.03: a hardwired monitor cannot be cleared.
        expect(
          await call(
            csms,
            "cvm-1",
            "ClearVariableMonitoring",
            { id: [HARDWIRED.id, PRECONFIGURED_2.id] },
            v.clear,
          ),
        ).toEqual({
          clearMonitoringResult: [
            { id: HARDWIRED.id, status: "Rejected" },
            { id: PRECONFIGURED_2.id, status: "Accepted" },
          ],
        });

        // N04.FR.18: nor replaced; a replaced preconfigured monitor keeps
        // its id and becomes custom (N04.FR.12, FR.15).
        const set = await call(
          csms,
          "svm-1",
          "SetVariableMonitoring",
          {
            setMonitoringData: [
              replacement(HARDWIRED),
              replacement(PRECONFIGURED),
            ],
          },
          v.set,
        );
        expect(set.setMonitoringResult).toMatchObject([
          {
            status: "Rejected",
            statusInfo: { reasonCode: "HardWiredMonitor" },
          },
          { status: "Accepted", id: PRECONFIGURED.id },
        ]);
        expect(cp.monitoring.get(PRECONFIGURED.id)).toMatchObject({
          value: 5,
          origin: "CustomMonitor",
        });

        const activeBase = async (messageId: string) => {
          const response = await call(
            csms,
            messageId,
            "GetVariables",
            {
              getVariableData: [
                {
                  component: { name: "MonitoringCtrlr" },
                  variable: { name: "ActiveMonitoringBase" },
                },
              ],
            },
            v.getVariables,
          );
          return (
            response.getVariableResult as { attributeValue?: string }[]
          )[0].attributeValue;
        };
        expect(await activeBase("gv-1")).toBe("All");

        // All: the cleared preconfigured monitor is back, the changed one
        // stays custom (N03.FR.03).
        await call(
          csms,
          "smb-all",
          "SetMonitoringBase",
          { monitoringBase: "All" },
          v.base,
        );
        expect(cp.monitoring.list().map((m) => [m.id, m.origin])).toEqual([
          [HARDWIRED.id, "HardWiredMonitor"],
          [PRECONFIGURED.id, "CustomMonitor"],
          [PRECONFIGURED_2.id, "PreconfiguredMonitor"],
        ]);

        // FactoryDefault: the original preconfigured monitor is back under
        // its id (N03.FR.04).
        await call(
          csms,
          "smb-fd",
          "SetMonitoringBase",
          { monitoringBase: "FactoryDefault" },
          v.base,
        );
        expect(cp.monitoring.get(PRECONFIGURED.id)).toEqual(PRECONFIGURED);
        expect(await activeBase("gv-2")).toBe("FactoryDefault");

        // HardWiredOnly: only the hardwired monitor stays (N03.FR.05).
        await call(
          csms,
          "smb-hw",
          "SetMonitoringBase",
          { monitoringBase: "HardWiredOnly" },
          v.base,
        );
        expect(cp.monitoring.list()).toEqual([HARDWIRED]);
        expect(await activeBase("gv-3")).toBe("HardWiredOnly");
        // The station's own monitors never fired a NotifyEvent.
        expect(
          csms.received.filter((f) => f[0] === 2 && f[2] === "NotifyEvent"),
        ).toEqual([]);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });
  }

  for (const v of VERSIONS) {
    it(`${v.version}: the monitoring base and the deleted preconfigured monitors survive a restart`, async () => {
      const db = BunSqliteDatabase.open(":memory:");
      const cpId = `CP-CATALOG-RESTART-${v.version}`;
      const first = startMockCsms();
      const before = makeChargePoint(first, cpId, v.version, db);
      try {
        before.connect();
        await bootAccepted(first);
        await call(
          first,
          "smb-hw",
          "SetMonitoringBase",
          { monitoringBase: "HardWiredOnly" },
          v.base,
        );
      } finally {
        before.disconnect();
        await first.stop();
      }

      const second = startMockCsms();
      const after = makeChargePoint(second, cpId, v.version, db);
      try {
        expect(after.monitoring.list()).toEqual([HARDWIRED]);
        expect(after.monitoring.activeMonitoringBase).toBe("HardWiredOnly");
        expect(after.configuration.getString("ActiveMonitoringBase")).toBe(
          "HardWiredOnly",
        );
      } finally {
        after.disconnect();
        await second.stop();
        db.close();
      }
    });

    it(`${v.version}: a database from before #538 keeps its custom ids and gains the catalog`, async () => {
      const db = BunSqliteDatabase.open(":memory:");
      const cpId = `CP-CATALOG-UPGRADE-${v.version}`;
      // A v21 row: custom monitor 1, no monitoring base stored.
      db.run(
        "INSERT INTO variable_monitors (cp_id, monitor_id, monitor) VALUES (?, 1, ?)",
        [
          cpId,
          JSON.stringify({
            id: 1,
            type: "Delta",
            severity: 4,
            value: 10,
            transaction: false,
            component: { name: "OCPPCommCtrlr" },
            variable: { name: "HeartbeatInterval" },
            valueKey: "HeartbeatInterval",
            origin: "CustomMonitor",
          }),
        ],
      );
      const csms = startMockCsms();
      const cp = makeChargePoint(csms, cpId, v.version, db);
      try {
        expect(cp.monitoring.list().map((m) => [m.id, m.origin])).toEqual([
          [1, "CustomMonitor"],
          [HARDWIRED.id, "HardWiredMonitor"],
          [PRECONFIGURED.id, "PreconfiguredMonitor"],
          [PRECONFIGURED_2.id, "PreconfiguredMonitor"],
        ]);
        const next = cp.monitoring.install({
          type: "Delta",
          severity: 5,
          value: 10,
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "HeartbeatInterval" },
          valueKey: "HeartbeatInterval",
          valueType: { numeric: true },
        });
        expect(next.status === "Accepted" && next.monitor.id).toBe(2);
      } finally {
        cp.disconnect();
        await csms.stop();
        db.close();
      }
    });
  }
});
