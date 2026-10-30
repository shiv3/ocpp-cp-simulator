import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidNotifyEventRequestV201 } from "../../../../ocpp/v201";
import { isValidNotifyEventRequestV21 } from "../../../../ocpp/v21";
import type { ChargePoint } from "../ChargePoint";
import { makeChargePoint } from "./chargePointFixtures";

/**
 * #538, OCPP 2.0.1 / 2.1 N08.FR.03: the periodic monitors keep their timers
 * while the station is offline, and a tick of a monitor at or below
 * `OfflineQueuingSeverity` is queued and delivered after the next Boot
 * Accepted; the period is kept once back online.
 */

const START = Date.parse("2026-10-30T12:00:17Z");

const VERSIONS = [
  { version: "OCPP-2.0.1", valid: isValidNotifyEventRequestV201, v21: false },
  { version: "OCPP-2.1", valid: isValidNotifyEventRequestV21, v21: true },
] as const;

interface EventData {
  trigger: string;
  timestamp: string;
  variableMonitoringId: number;
  severity?: number;
}

/** The handler's socket goes up, and its NotifyEvent payloads are captured. */
function online(cp: ChargePoint): Record<string, unknown>[] {
  const handler = cp["_messageHandler"] as unknown as {
    send: (action: string, id: string, payload: unknown) => void;
    _webSocket: { isConnected: () => boolean };
  };
  vi.spyOn(handler._webSocket, "isConnected").mockReturnValue(true);
  const sent: Record<string, unknown>[] = [];
  vi.spyOn(handler, "send").mockImplementation((action, _id, payload) => {
    if (action === "NotifyEvent") sent.push(payload as Record<string, unknown>);
  });
  return sent;
}

function bootAccepted(cp: ChargePoint): void {
  cp.onBootNotificationResult({
    status: "Accepted",
    interval: 0,
    currentTime: new Date().toISOString(),
  });
}

function installPeriodic(cp: ChargePoint, severity: number) {
  return cp.monitoring.install({
    type: "Periodic",
    severity,
    value: 60,
    component: { name: "OCPPCommCtrlr" },
    variable: { name: "HeartbeatInterval" },
    valueKey: "HeartbeatInterval",
    valueType: { numeric: true },
  });
}

const data = (payload: Record<string, unknown>) =>
  (payload.eventData as EventData[])[0];

describe.each(VERSIONS)(
  "$version periodic monitors offline (N08.FR.03)",
  (v) => {
    let cp: ChargePoint;

    beforeEach(() => {
      vi.useFakeTimers({ now: START });
      cp = makeChargePoint({
        id: "cp-offline-periodic",
        ocppVersion: v.version,
      });
      expect(cp.configuration.applyChange("OfflineQueuingSeverity", "5")).toBe(
        "Accepted",
      );
    });

    afterEach(() => {
      cp.dispose();
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("queues the ticks produced offline and delivers them after Boot Accepted, keeping the period", async () => {
      installPeriodic(cp, 5);
      installPeriodic(cp, 6);
      await vi.advanceTimersByTimeAsync(120_000);

      const sent = online(cp);
      bootAccepted(cp);
      await vi.advanceTimersByTimeAsync(0);
      expect(sent.every((p) => v.valid(p))).toBe(true);
      expect(
        sent.map((p) => [data(p).variableMonitoringId, data(p).timestamp]),
      ).toEqual([
        [1, "2026-10-30T12:01:17.000Z"],
        [1, "2026-10-30T12:02:17.000Z"],
      ]);
      expect(data(sent[0]).trigger).toBe("Periodic");
      expect(data(sent[0]).severity).toBe(v.v21 ? 5 : undefined);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(sent.slice(2).map((p) => data(p).timestamp)).toEqual([
        "2026-10-30T12:03:17.000Z",
        "2026-10-30T12:03:17.000Z",
      ]);
    });

    it("stops the offline timers on dispose", async () => {
      installPeriodic(cp, 5);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      cp.dispose();
      await vi.advanceTimersByTimeAsync(600_000);
      const sent = online(cp);
      bootAccepted(cp);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sent).toEqual([]);
    });
  },
);
