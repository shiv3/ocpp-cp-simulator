import { describe, expect, it } from "bun:test";
import {
  isValidNotifyEventRequestV201,
  isValidSetMonitoringBaseResponseV201,
} from "../../../../ocpp/v201";
import {
  isValidNotifyEventRequestV21,
  isValidSetMonitoringBaseResponseV21,
} from "../../../../ocpp/v21";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";
import { BunSqliteDatabase } from "../../../domain/persistence/BunSqliteDatabase";
import type { Database } from "../../../domain/persistence/Database";

/**
 * #457 part B: monitors installed by SetVariableMonitoring are evaluated
 * whenever SetVariables / ChangeConfiguration changes the value they watch,
 * and report through NotifyEvent (N07), filtered by the monitoring level
 * (N05.FR.03). SetMonitoringBase acts on the custom monitors (N03), and the
 * monitors survive a restart on --state-db (N07.FR.13, FR.14).
 */

const VERSIONS = [
  {
    version: "OCPP-2.0.1",
    notifyEvent: isValidNotifyEventRequestV201,
    baseResponse: isValidSetMonitoringBaseResponseV201,
    severity: false,
  },
  {
    version: "OCPP-2.1",
    notifyEvent: isValidNotifyEventRequestV21,
    baseResponse: isValidSetMonitoringBaseResponseV21,
    severity: true,
  },
] as const;

const HEARTBEAT = {
  component: { name: "OCPPCommCtrlr" },
  variable: { name: "HeartbeatInterval" },
};

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

async function bootAccepted(csms: MockCsms, statusAction: string) {
  const boot = await csms.waitForCall("BootNotification");
  csms.replyCallResult(boot.messageId, {
    status: "Accepted",
    currentTime: "2026-10-29T00:00:00.000Z",
    interval: 300,
  });
  await csms.waitForFrame((f) => f[0] === 2 && f[2] === statusAction);
}

const resultFor = (messageId: string) => (frame: OcppFrame) =>
  frame[0] === 3 && frame[1] === messageId;

async function call(
  csms: MockCsms,
  messageId: string,
  action: string,
  payload: unknown,
): Promise<Record<string, unknown>> {
  csms.send([2, messageId, action, payload]);
  const frame = await csms.waitForFrame(resultFor(messageId));
  return frame[2] as Record<string, unknown>;
}

function setHeartbeat(csms: MockCsms, messageId: string, value: number) {
  return call(csms, messageId, "SetVariables", {
    setVariableData: [{ attributeValue: String(value), ...HEARTBEAT }],
  });
}

function notifyEvents(csms: MockCsms): OcppFrame[] {
  return csms.received.filter((f) => f[0] === 2 && f[2] === "NotifyEvent");
}

interface EventData {
  trigger: string;
  cleared?: boolean;
  actualValue: string;
  variableMonitoringId?: number;
  severity?: number;
}

async function nextNotifyEvent(
  csms: MockCsms,
  after: number,
): Promise<{ payload: Record<string, unknown>; data: EventData }> {
  const frame = await csms.waitForFrame(
    (f) =>
      f[0] === 2 && f[2] === "NotifyEvent" && notifyEvents(csms).length > after,
  );
  const latest = notifyEvents(csms)[after] ?? frame;
  csms.replyCallResult(latest[1] as string, {});
  const payload = latest[3] as Record<string, unknown>;
  return {
    payload,
    data: (payload.eventData as EventData[])[0],
  };
}

describe("OCPP 2.x NotifyEvent from variable monitors (#457)", () => {
  for (const v of VERSIONS) {
    it(`${v.version}: threshold crossings send schema-valid trigger and cleared events, filtered by level`, async () => {
      const csms = startMockCsms();
      const cp = makeChargePoint(csms, `CP-EVENTS-${v.version}`, v.version);
      try {
        cp.connect();
        await bootAccepted(csms, "StatusNotification");

        const set = await call(csms, "svm-1", "SetVariableMonitoring", {
          setMonitoringData: [
            { value: 600, type: "UpperThreshold", severity: 4, ...HEARTBEAT },
            { value: 30, type: "LowerThreshold", severity: 4, ...HEARTBEAT },
            { value: 100, type: "Delta", severity: 8, ...HEARTBEAT },
          ],
        });
        expect(
          (set.setMonitoringResult as { status: string }[]).map(
            (r) => r.status,
          ),
        ).toEqual(["Accepted", "Accepted", "Accepted"]);
        await call(csms, "sml-1", "SetMonitoringLevel", { severity: 7 });

        // Upper threshold: on the value is not above it (N07.FR.16).
        await setHeartbeat(csms, "sv-600", 600);
        await setHeartbeat(csms, "sv-700", 700);
        const trigger = await nextNotifyEvent(csms, 0);
        expect(v.notifyEvent(trigger.payload)).toBe(true);
        expect(trigger.payload).toMatchObject({ seqNo: 0, tbc: false });
        expect(trigger.data).toMatchObject({
          eventId: 1,
          trigger: "Alerting",
          actualValue: "700",
          eventNotificationType: "CustomMonitor",
          variableMonitoringId: 1,
          ...HEARTBEAT,
        });
        expect(trigger.data.cleared).toBeUndefined();
        expect(trigger.data.severity).toBe(v.severity ? 4 : undefined);
        // Sent after the SetVariables answer that caused it.
        expect(
          csms.received.findIndex((f) => f[0] === 2 && f[2] === "NotifyEvent"),
        ).toBeGreaterThan(csms.received.findIndex(resultFor("sv-700")));

        // Back within range: cleared (N07.FR.02).
        await setHeartbeat(csms, "sv-300", 300);
        const cleared = await nextNotifyEvent(csms, 1);
        expect(v.notifyEvent(cleared.payload)).toBe(true);
        expect(cleared.data).toMatchObject({
          trigger: "Alerting",
          cleared: true,
          actualValue: "300",
          variableMonitoringId: 1,
        });

        // Lower threshold (N07.FR.17).
        await setHeartbeat(csms, "sv-20", 20);
        const lower = await nextNotifyEvent(csms, 2);
        expect(lower.data).toMatchObject({
          trigger: "Alerting",
          actualValue: "20",
          variableMonitoringId: 2,
        });

        // The severity 8 Delta never reported at level 7; at level 9 it does.
        expect(
          notifyEvents(csms).map(
            (f) =>
              ((f[3] as { eventData: EventData[] }).eventData[0] as EventData)
                .variableMonitoringId,
          ),
        ).toEqual([1, 1, 2]);
        await call(csms, "sml-2", "SetMonitoringLevel", { severity: 9 });
        await setHeartbeat(csms, "sv-500", 500);
        const delta = await nextNotifyEvent(csms, 3);
        expect(v.notifyEvent(delta.payload)).toBe(true);
        expect(
          (delta.payload.eventData as EventData[]).map((d) => [
            d.variableMonitoringId,
            d.trigger,
            d.cleared,
          ]),
        ).toEqual([
          // 500 is back above the lower threshold, and 480 from the last
          // Delta baseline (20): both monitors in one request.
          [2, "Alerting", true],
          [3, "Delta", undefined],
        ]);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it(`${v.version}: SetMonitoringBase keeps or deletes the custom monitors (N03)`, async () => {
      const csms = startMockCsms();
      const cp = makeChargePoint(csms, `CP-BASE-${v.version}`, v.version);
      try {
        cp.connect();
        await bootAccepted(csms, "StatusNotification");
        await call(csms, "svm-1", "SetVariableMonitoring", {
          setMonitoringData: [
            { value: 600, type: "UpperThreshold", severity: 4, ...HEARTBEAT },
          ],
        });
        await setHeartbeat(csms, "sv-700", 700);
        await nextNotifyEvent(csms, 0);

        const all = await call(csms, "smb-all", "SetMonitoringBase", {
          monitoringBase: "All",
        });
        expect(v.baseResponse(all)).toBe(true);
        expect(all).toEqual({ status: "Accepted" });
        expect(cp.monitoring.list().map((m) => m.id)).toEqual([1]);

        for (const base of ["FactoryDefault", "HardWiredOnly"]) {
          await call(csms, `svm-${base}`, "SetVariableMonitoring", {
            setMonitoringData: [
              { value: 10, type: "Delta", severity: 4, ...HEARTBEAT },
            ],
          });
          const response = await call(
            csms,
            `smb-${base}`,
            "SetMonitoringBase",
            {
              monitoringBase: base,
            },
          );
          expect(v.baseResponse(response)).toBe(true);
          expect(response).toEqual({ status: "Accepted" });
          expect(cp.monitoring.list()).toEqual([]);
        }

        // The deleted, triggered monitor sends no cleared event (N07.FR.12).
        await setHeartbeat(csms, "sv-300", 300);
        expect(notifyEvents(csms)).toHaveLength(1);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });
  }

  it("OCPP 1.6: a ChangeConfiguration sends no NotifyEvent, even with a monitor in the store", async () => {
    const csms = startMockCsms();
    const cp = makeChargePoint(csms, "CP-EVENTS-16", "OCPP-1.6J");
    try {
      cp.connect();
      await bootAccepted(csms, "StatusNotification");
      cp.monitoring.install({
        type: "Delta",
        severity: 0,
        value: 0,
        ...HEARTBEAT,
        valueKey: "HeartbeatInterval",
        valueType: { numeric: true },
      });

      expect(
        await call(csms, "cc-1", "ChangeConfiguration", {
          key: "HeartbeatInterval",
          value: "700",
        }),
      ).toEqual({ status: "Accepted" });
      // Sentinel: a second answered CALL; a deferred NotifyEvent of the
      // first change would have been written before it.
      await call(csms, "gc-1", "GetConfiguration", {
        key: ["HeartbeatInterval"],
      });
      expect(notifyEvents(csms)).toEqual([]);
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("OCPP 2.0.1: monitors and their triggered state survive a restart; the level does not (N07.FR.13, FR.14)", async () => {
    const db = BunSqliteDatabase.open(":memory:");
    const cpId = "CP-MONITOR-RESTART";
    const first = startMockCsms();
    const before = makeChargePoint(first, cpId, "OCPP-2.0.1", db);
    try {
      before.connect();
      await bootAccepted(first, "StatusNotification");
      await call(first, "svm-1", "SetVariableMonitoring", {
        setMonitoringData: [
          { value: 600, type: "UpperThreshold", severity: 4, ...HEARTBEAT },
          { value: 10, type: "Delta", severity: 5, ...HEARTBEAT },
          { value: 5, type: "Delta", severity: 6, ...HEARTBEAT },
        ],
      });
      await call(first, "cvm-1", "ClearVariableMonitoring", { id: [3] });
      await call(first, "sml-1", "SetMonitoringLevel", { severity: 4 });
      await setHeartbeat(first, "sv-700", 700);
      const trigger = await nextNotifyEvent(first, 0);
      expect(trigger.data).toMatchObject({ variableMonitoringId: 1 });
    } finally {
      before.disconnect();
      await first.stop();
    }

    const second = startMockCsms();
    const after = makeChargePoint(second, cpId, "OCPP-2.0.1", db);
    try {
      expect(after.monitoring.list()).toEqual(before.monitoring.list());
      expect(after.monitoring.monitoringLevel).toBe(9);

      after.connect();
      await bootAccepted(second, "StatusNotification");
      // The value that triggered before the restart returns within range.
      await setHeartbeat(second, "sv-300", 300);
      const cleared = await nextNotifyEvent(second, 0);
      expect(
        (cleared.payload.eventData as EventData[]).map((d) => [
          d.variableMonitoringId,
          d.trigger,
          d.cleared,
        ]),
      ).toEqual([
        [1, "Alerting", true],
        [2, "Delta", undefined],
      ]);

      // Ids resume after the highest restored one (N04.FR.19).
      const set = await call(second, "svm-2", "SetVariableMonitoring", {
        setMonitoringData: [
          { value: 30, type: "LowerThreshold", severity: 4, ...HEARTBEAT },
        ],
      });
      expect(
        (set.setMonitoringResult as { id?: number }[]).map((r) => r.id),
      ).toEqual([3]);
      await call(second, "cvm-2", "ClearVariableMonitoring", { id: [1] });
    } finally {
      after.disconnect();
      await second.stop();
    }

    const third = startMockCsms();
    const reopened = makeChargePoint(third, cpId, "OCPP-2.0.1", db);
    try {
      expect(reopened.monitoring.list().map((m) => m.id)).toEqual([2, 3]);
    } finally {
      reopened.disconnect();
      await third.stop();
      db.close();
    }
  });
});
