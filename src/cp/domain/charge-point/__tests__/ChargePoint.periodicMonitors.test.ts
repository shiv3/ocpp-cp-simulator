import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidNotifyEventRequestV201 } from "../../../../ocpp/v201";
import { isValidNotifyEventRequestV21 } from "../../../../ocpp/v21";
import type { ChargePoint } from "../ChargePoint";
import { makeChargePoint } from "./chargePointFixtures";

/**
 * #538: Periodic and PeriodicClockAligned monitors (N08) on a 2.x charge
 * point: NotifyEvent with trigger Periodic, sent only while the boot is
 * Accepted, timers stopped while Pending and on dispose. Offline the
 * timers run (N08.FR.03): see ChargePoint.offlineMonitoring.test.ts.
 */

const START = Date.parse("2026-10-28T12:00:17Z");

const VERSIONS = [
  { version: "OCPP-2.0.1", valid: isValidNotifyEventRequestV201, v21: false },
  { version: "OCPP-2.1", valid: isValidNotifyEventRequestV21, v21: true },
] as const;

interface EventData {
  trigger: string;
  actualValue: string;
  variableMonitoringId: number;
  timestamp: string;
  severity?: number;
}

/** NotifyEvent payloads the handler writes, in order. The socket reads as
 *  connected: a NotifyEvent finding it down would be queued (#538). */
function captureNotifyEvents(cp: ChargePoint): Record<string, unknown>[] {
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

function installPeriodic(cp: ChargePoint, type: string, value: number) {
  return cp.monitoring.install({
    type,
    severity: 4,
    value,
    component: { name: "OCPPCommCtrlr" },
    variable: { name: "HeartbeatInterval" },
    valueKey: "HeartbeatInterval",
    valueType: { numeric: true },
  });
}

const data = (payload: Record<string, unknown>) =>
  (payload.eventData as EventData[])[0];

describe.each(VERSIONS)("$version periodic monitors (N08)", (v) => {
  let cp: ChargePoint;

  beforeEach(() => {
    vi.useFakeTimers({ now: START });
    cp = makeChargePoint({ id: "cp-periodic", ocppVersion: v.version });
  });

  afterEach(() => {
    cp.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends a schema-valid NotifyEvent with trigger Periodic every interval (N08.FR.04-FR.06)", async () => {
    const sent = captureNotifyEvents(cp);
    bootAccepted(cp);
    expect(installPeriodic(cp, "Periodic", 60).status).toBe("Accepted");

    await vi.advanceTimersByTimeAsync(120_000);

    expect(sent).toHaveLength(2);
    for (const payload of sent) {
      expect(v.valid(payload)).toBe(true);
      expect(payload).toMatchObject({ seqNo: 0, tbc: false });
    }
    expect(
      sent.map((p) => [
        data(p).trigger,
        data(p).timestamp,
        data(p).actualValue,
        data(p).variableMonitoringId,
      ]),
    ).toEqual([
      ["Periodic", "2026-10-28T12:01:17.000Z", "300", 1],
      ["Periodic", "2026-10-28T12:02:17.000Z", "300", 1],
    ]);
    expect(data(sent[0]).severity).toBe(v.v21 ? 4 : undefined);
  });

  it("aligns PeriodicClockAligned on the clock (N08.FR.07)", async () => {
    const sent = captureNotifyEvents(cp);
    bootAccepted(cp);
    installPeriodic(cp, "PeriodicClockAligned", 900);

    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(sent.every((p) => v.valid(p))).toBe(true);
    expect(sent.map((p) => data(p).timestamp)).toEqual([
      "2026-10-28T12:15:00.000Z",
      "2026-10-28T12:30:00.000Z",
    ]);
  });

  it("sends nothing before the boot is Accepted (B02.FR.02)", async () => {
    const sent = captureNotifyEvents(cp);
    installPeriodic(cp, "Periodic", 60);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sent).toEqual([]);

    bootAccepted(cp);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(1);
  });

  it("stops the timers when the boot is no longer Accepted and on dispose", async () => {
    const sent = captureNotifyEvents(cp);
    bootAccepted(cp);
    installPeriodic(cp, "Periodic", 60);
    cp.onBootNotificationResult({
      status: "Pending",
      interval: 0,
      currentTime: new Date().toISOString(),
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sent).toEqual([]);

    bootAccepted(cp);
    const before = vi.getTimerCount();
    cp.dispose();
    expect(vi.getTimerCount()).toBeLessThan(before);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sent).toEqual([]);
  });
});
