import { describe, expect, it } from "bun:test";
import {
  isValidGetVariablesResponseV201,
  isValidNotifyEventRequestV201,
  isValidSetVariablesResponseV201,
} from "../../../../ocpp/v201";
import {
  isValidGetVariablesResponseV21,
  isValidNotifyEventRequestV21,
  isValidSetVariablesResponseV21,
} from "../../../../ocpp/v21";
import { answerTo, startMockCsms, type MockCsms } from "./mockCsms";
import { bootedChargePoint, callOf } from "./stationHarness";

/**
 * #538, OCPP 2.0.1 / 2.1 N07.FR.04: while offline, a monitor at or below
 * `MonitoringCtrlr.OfflineQueuingSeverity` has its NotifyEvent queued and
 * delivered once back online — after the next Boot Accepted, never in the
 * window between the reconnection and the boot answer (B02.FR.02). A
 * monitor above it is evaluated by the re-check of the Accepted boot, sent
 * after the replay; a queued event is not reported a second time.
 */

const VERSIONS = [
  {
    version: "OCPP-2.0.1",
    notifyEvent: isValidNotifyEventRequestV201,
    getVariables: isValidGetVariablesResponseV201,
    setVariables: isValidSetVariablesResponseV201,
  },
  {
    version: "OCPP-2.1",
    notifyEvent: isValidNotifyEventRequestV21,
    getVariables: isValidGetVariablesResponseV21,
    setVariables: isValidSetVariablesResponseV21,
  },
] as const;

const OFFLINE_QUEUING_SEVERITY = {
  component: { name: "MonitoringCtrlr" },
  variable: { name: "OfflineQueuingSeverity" },
};

/** Answer the next BootNotification after `from` frames with Accepted. */
async function bootAccepted(csms: MockCsms, from: number): Promise<void> {
  const boot = await csms.waitForFrame(
    (f) =>
      f[0] === 2 &&
      f[2] === "BootNotification" &&
      csms.received.indexOf(f) >= from,
  );
  csms.replyCallResult(boot[1] as string, {
    status: "Accepted",
    currentTime: "2026-10-30T00:00:00.000Z",
    interval: 300,
  });
}

async function call(
  csms: MockCsms,
  messageId: string,
  action: string,
  payload: unknown,
): Promise<Record<string, unknown>> {
  csms.send([2, messageId, action, payload]);
  const frame = await csms.waitForFrame(answerTo(messageId));
  return frame[2] as Record<string, unknown>;
}

interface EventData {
  trigger: string;
  cleared?: boolean;
  actualValue: string;
  variableMonitoringId: number;
}

const notifyEventsFrom = (csms: MockCsms, from: number) =>
  csms.received.slice(from).filter(callOf("NotifyEvent"));

describe("OCPP 2.x offline NotifyEvent queuing (#538, N07.FR.04)", () => {
  for (const v of VERSIONS) {
    it(`${v.version}: publishes OfflineQueuingSeverity as a ReadWrite 0-9 variable`, async () => {
      const csms = startMockCsms();
      const cp = await bootedChargePoint(
        csms,
        `CP-OQS-${v.version}`,
        v.version,
      );
      try {
        const initial = await call(csms, "gv-1", "GetVariables", {
          getVariableData: [OFFLINE_QUEUING_SEVERITY],
        });
        expect(v.getVariables(initial)).toBe(true);
        expect(initial.getVariableResult).toMatchObject([
          { attributeStatus: "Accepted", attributeValue: "0" },
        ]);

        const set = await call(csms, "sv-1", "SetVariables", {
          setVariableData: [
            { attributeValue: "5", ...OFFLINE_QUEUING_SEVERITY },
            { attributeValue: "10", ...OFFLINE_QUEUING_SEVERITY },
          ],
        });
        expect(v.setVariables(set)).toBe(true);
        expect(
          (set.setVariableResult as { attributeStatus: string }[]).map(
            (r) => r.attributeStatus,
          ),
        ).toEqual(["Accepted", "Rejected"]);
        expect(cp.configuration.offlineQueuingSeverity()).toBe(5);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it(`${v.version}: queues the events at or below the severity offline and replays them before the re-check`, async () => {
      const csms = startMockCsms();
      const cp = await bootedChargePoint(
        csms,
        `CP-OFFLINE-NE-${v.version}`,
        v.version,
      );
      try {
        await call(csms, "sv-oqs", "SetVariables", {
          setVariableData: [
            { attributeValue: "5", ...OFFLINE_QUEUING_SEVERITY },
          ],
        });
        const install = (value: number, severity: number) =>
          cp.monitoring.install({
            type: "UpperThreshold",
            severity,
            value,
            component: { name: "OCPPCommCtrlr" },
            variable: { name: "HeartbeatInterval" },
            valueKey: "HeartbeatInterval",
            valueType: { numeric: true },
          });
        // 1: queued offline; 2: held (severity above 5); 3: queued.
        install(400, 4);
        install(400, 7);
        install(550, 5);

        cp.disconnect();
        const reconnectedAt = csms.received.length;
        expect(cp.configuration.applyChange("HeartbeatInterval", "500")).toBe(
          "Accepted",
        );
        cp.connect();
        await csms.waitForFrame(
          (f) =>
            f[0] === 2 &&
            f[2] === "BootNotification" &&
            csms.received.indexOf(f) >= reconnectedAt,
        );
        // Connected, boot not answered yet: still queued, never sent.
        cp.configuration.applyChange("HeartbeatInterval", "600");
        await bootAccepted(csms, reconnectedAt);

        await csms.waitForFrame(
          () => notifyEventsFrom(csms, reconnectedAt).length >= 3,
        );
        // A sentinel round-trip: anything else would be out by now.
        await call(csms, "gv-sentinel", "GetVariables", {
          getVariableData: [OFFLINE_QUEUING_SEVERITY],
        });
        const frames = notifyEventsFrom(csms, reconnectedAt);
        for (const frame of frames) {
          expect(v.notifyEvent(frame[3])).toBe(true);
          expect(frame[3]).not.toHaveProperty("offline");
        }
        expect(
          frames.map((f) => {
            const data = (f[3] as { eventData: EventData[] }).eventData;
            return data.map((d) => [
              d.variableMonitoringId,
              d.trigger,
              d.actualValue,
            ]);
          }),
        ).toEqual([
          [[1, "Alerting", "500"]],
          [[3, "Alerting", "600"]],
          // The re-check of the Accepted boot: only the held monitor.
          [[2, "Alerting", "600"]],
        ]);
        // Nothing before the boot answer and the post-boot status.
        const bootIndex = csms.received.findIndex(
          (f, i) =>
            i >= reconnectedAt && f[0] === 2 && f[2] === "BootNotification",
        );
        const statusIndex = csms.received.findIndex(
          (f, i) =>
            i > bootIndex && f[0] === 2 && f[2] === "StatusNotification",
        );
        expect(csms.received.indexOf(frames[0])).toBeGreaterThan(statusIndex);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });
  }
});
