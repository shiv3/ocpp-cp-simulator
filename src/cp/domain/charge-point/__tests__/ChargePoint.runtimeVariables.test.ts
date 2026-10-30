import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidNotifyEventRequestV201 } from "../../../../ocpp/v201";
import { isValidNotifyEventRequestV21 } from "../../../../ocpp/v21";
import { OCPPStatus } from "../../types/OcppTypes";
import type { ChargePoint } from "../ChargePoint";
import { makeChargePoint } from "./chargePointFixtures";

/**
 * #538: a 2.x station publishes runtime values as device-model variables
 * (EVSE.Power, EVSE / Connector / ChargingStation AvailabilityState), so a
 * monitor on them reports through NotifyEvent as they change, and only
 * when they change.
 */

const VERSIONS = [
  { version: "OCPP-2.0.1", valid: isValidNotifyEventRequestV201 },
  { version: "OCPP-2.1", valid: isValidNotifyEventRequestV21 },
] as const;

interface EventData {
  trigger: string;
  cleared?: boolean;
  actualValue: string;
  variableMonitoringId: number;
  component: { name: string; evse?: { id: number } };
}

/** NotifyEvent payloads the handler writes. The socket reads as connected:
 *  a NotifyEvent finding it down would be queued (#538). */
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

const value = (cp: ChargePoint, key: string) =>
  cp.configuration.get(key)?.value;

/** Let the microtask that sends NotifyEvent run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function startCharging(cp: ChargePoint, connectorId: number, kw: number) {
  const connector = cp.connectors.get(connectorId);
  if (!connector) throw new Error(`no connector ${connectorId}`);
  connector.evSettings = { ...connector.evSettings, maxChargingPowerKw: kw };
  connector.status = OCPPStatus.Charging;
  return connector;
}

describe.each(VERSIONS)("$version runtime device-model values (#538)", (v) => {
  let cp: ChargePoint;

  afterEach(() => {
    cp.dispose();
    vi.restoreAllMocks();
  });

  it("publishes EVSE.Power and the AvailabilityStates of every EVSE, read-only", () => {
    cp = makeChargePoint({ ocppVersion: v.version, connectorCount: 2 });
    bootAccepted(cp);
    expect(value(cp, "EVSEPower1")).toBe(0);
    expect(value(cp, "EVSEAvailabilityState2")).toBe("Available");
    expect(value(cp, "ConnectorAvailabilityState2")).toBe("Available");
    expect(value(cp, "ChargingStationAvailabilityState")).toBe("Available");
    expect(cp.configuration.applyChange("EVSEPower1", "5")).toBe("Rejected");

    startCharging(cp, 1, 7.4);
    expect(value(cp, "EVSEPower1")).toBe(7400);
    expect(value(cp, "EVSEAvailabilityState1")).toBe("Occupied");
    expect(value(cp, "ConnectorAvailabilityState1")).toBe("Occupied");
    expect(value(cp, "EVSEAvailabilityState2")).toBe("Available");

    cp.connectors.get(1)!.status = OCPPStatus.Faulted;
    expect(value(cp, "EVSEPower1")).toBe(0);
    expect(value(cp, "EVSEAvailabilityState1")).toBe("Faulted");
  });

  it("follows the station status set through connector 0", () => {
    cp = makeChargePoint({ ocppVersion: v.version });
    bootAccepted(cp);
    cp.updateConnectorStatus(0, OCPPStatus.Unavailable);
    expect(value(cp, "ChargingStationAvailabilityState")).toBe("Unavailable");
    cp.updateConnectorStatus(0, OCPPStatus.Faulted);
    expect(value(cp, "ChargingStationAvailabilityState")).toBe("Faulted");
  });

  it("fires monitors on the runtime values, with the monitor's EVSE (N07.FR.16, FR.19)", async () => {
    cp = makeChargePoint({ ocppVersion: v.version, connectorCount: 2 });
    const sent = captureNotifyEvents(cp);
    bootAccepted(cp);
    const power = cp.monitoring.install({
      type: "UpperThreshold",
      severity: 3,
      value: 5000,
      component: { name: "EVSE", evse: { id: 1 } },
      variable: { name: "Power" },
      valueKey: "EVSEPower1",
      valueType: { numeric: true },
    });
    const state = cp.monitoring.install({
      type: "Delta",
      severity: 3,
      value: 0,
      component: { name: "EVSE", evse: { id: 1 } },
      variable: { name: "AvailabilityState" },
      valueKey: "EVSEAvailabilityState1",
      valueType: { numeric: false },
    });
    expect([power.status, state.status]).toEqual(["Accepted", "Accepted"]);
    await flush();
    expect(sent).toEqual([]);

    startCharging(cp, 1, 7.4);
    await flush();
    cp.connectors.get(1)!.status = OCPPStatus.Available;
    await flush();

    expect(sent.every((p) => v.valid(p))).toBe(true);
    const events = sent.flatMap((p) => p.eventData as EventData[]);
    expect(
      events.map((e) => [
        e.variableMonitoringId,
        e.trigger,
        e.actualValue,
        e.cleared ?? false,
      ]),
    ).toEqual([
      // The status change first moves the power (Charging), then the state.
      [1, "Alerting", "7400", false],
      [2, "Delta", "Occupied", false],
      [1, "Alerting", "0", true],
      [2, "Delta", "Available", false],
    ]);
    expect(events[0].component).toEqual({ name: "EVSE", evse: { id: 1 } });
  });

  it("drops a removed connector's keys and target, and its periodic monitor reports nothing", async () => {
    vi.useFakeTimers();
    try {
      cp = makeChargePoint({ ocppVersion: v.version, connectorCount: 2 });
      const sent = captureNotifyEvents(cp);
      bootAccepted(cp);
      const periodic = cp.monitoring.install({
        type: "Periodic",
        severity: 3,
        value: 10,
        component: { name: "EVSE", evse: { id: 2 } },
        variable: { name: "Power" },
        valueKey: "EVSEPower2",
        valueType: { numeric: true },
      });
      expect(periodic.status).toBe("Accepted");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent).toHaveLength(1);

      expect(cp.removeConnector(2)).toBe(true);

      for (const key of [
        "EVSEPower2",
        "EVSEAvailabilityState2",
        "ConnectorAvailabilityState2",
      ]) {
        expect(cp.configuration.get(key)).toBeUndefined();
      }
      expect(value(cp, "EVSEPower1")).toBe(0);
      expect(cp.deviceModelTargets.supports("EVSEPower2")).toBe(false);
      expect(cp.deviceModelTargets.supports("EVSEPower1")).toBe(
        v.version === "OCPP-2.1",
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("evaluates only on change: meter ticks at the same power publish nothing", () => {
    cp = makeChargePoint({ ocppVersion: v.version });
    const connector = startCharging(cp, 1, 11);
    const changes: string[] = [];
    cp.configuration.onChange((key) => changes.push(key));
    connector.meterValue = 100;
    connector.meterValue = 200;
    connector.status = OCPPStatus.Charging;
    expect(changes).toEqual([]);

    connector.evSettings = { ...connector.evSettings, maxChargingPowerKw: 7 };
    expect(changes).toEqual(["EVSEPower1"]);
  });
});

describe("OCPP 1.6 runtime values", () => {
  it("publishes no 2.x device-model runtime value", () => {
    const cp = makeChargePoint({ ocppVersion: "OCPP-1.6J" });
    try {
      expect(cp.configuration.get("EVSEPower1")).toBeUndefined();
      expect(
        cp.configuration.get("ChargingStationAvailabilityState"),
      ).toBeUndefined();
    } finally {
      cp.dispose();
    }
  });
});

describe("EVSE.Power Target and TargetDelta monitors (2.1, #538)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("2.1 gives EVSE.Power a Target; a TargetDelta monitor fires on actual or target changes (N07.FR.22)", async () => {
    const cp = makeChargePoint({ ocppVersion: "OCPP-2.1", connectorCount: 2 });
    try {
      const sent = captureNotifyEvents(cp);
      bootAccepted(cp);
      const targets = cp.deviceModelTargets;
      expect([1, 2].map((n) => targets.supports(`EVSEPower${n}`))).toEqual([
        true,
        true,
      ]);
      expect(
        cp.monitoring.install({
          type: "TargetDelta",
          severity: 2,
          value: 100,
          component: { name: "EVSE", evse: { id: 1 } },
          variable: { name: "Power" },
          valueKey: "EVSEPower1",
          valueType: { numeric: true, hasTarget: true },
        }).status,
      ).toBe("Accepted");

      // No target yet: nothing to compare the actual value with.
      startCharging(cp, 1, 7.4);
      await flush();
      expect(sent).toEqual([]);
      targets.set("EVSEPower1", 7000);
      await flush();
      targets.set("EVSEPower1", 7350);
      await flush();

      expect(sent.every((p) => isValidNotifyEventRequestV21(p))).toBe(true);
      expect(
        sent
          .flatMap((p) => p.eventData as EventData[])
          .map((e) => [e.trigger, e.actualValue, e.cleared ?? false]),
      ).toEqual([
        ["Alerting", "7400", false],
        ["Alerting", "7400", true],
      ]);
    } finally {
      cp.dispose();
    }
  });

  it("2.0.1 has no Target attribute", () => {
    const cp = makeChargePoint({ ocppVersion: "OCPP-2.0.1" });
    try {
      expect(cp.deviceModelTargets.supports("EVSEPower1")).toBe(false);
    } finally {
      cp.dispose();
    }
  });
});
