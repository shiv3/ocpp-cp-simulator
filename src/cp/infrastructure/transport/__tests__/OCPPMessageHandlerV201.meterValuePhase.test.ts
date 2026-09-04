import { describe, it, expect, vi } from "vitest";
import { OCPPMessageHandlerV201 } from "../OCPPMessageHandlerV201";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import { Logger } from "../../../shared/Logger";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { MeterValuesRequestV201 } from "../../../../ocpp";

/**
 * Transport-boundary regression for #301 finding 1: `MeterValueBuilder`
 * tags per-phase samples with `phase` (L1/L2/L3) on a 3-phase AC connector,
 * and `sendMeterValue` must carry that tag onto the wire payload rather than
 * silently dropping it — a CSMS otherwise receives four indistinguishable
 * `Current.Import` samples instead of an aggregate plus L1/L2/L3.
 */

class FakeSocket {
  sentCalls: Array<{ action: string; payload: unknown }> = [];
  setMessageHandler(): void {}
  onCloseTransaction(): void {}
  isConnected(): boolean {
    return true;
  }
  currentGeneration(): { gen: number; closeCause: string | null } {
    return { gen: 1, closeCause: null };
  }
  sendAction(
    _messageId: string,
    action: string,
    payload: unknown,
    _gen: unknown,
    onSettled?: (s: { outcome: string }) => void,
  ): boolean {
    this.sentCalls.push({ action, payload });
    onSettled?.({ outcome: "written" });
    return true;
  }
}

/** The slice of `Connector` `MeterValueBuilder` reads — see
 *  `MeterValueBuilder.curve.test.ts` for the same fixture shape. */
function threePhaseConnectorStub(): unknown {
  return {
    status: "Charging",
    soc: 50,
    meterValue: 0,
    transaction: null,
    evSettings: {
      modelName: "Test EV",
      batteryCapacityKwh: 75,
      maxChargingPowerKw: 22,
      initialSoc: 20,
      targetSoc: 80,
      currentType: "AC",
      phases: 3,
      voltageV: 230,
    },
    currentScheduleLimitWatts: () => Infinity,
    // Three phases in use: no profile restricts them (#301).
    activePhaseCount: () => 3,
  };
}

function createMockChargePoint(connector: unknown): ChargePoint {
  return {
    getConnector: vi.fn(() => connector),
    notifyOutgoingCall: vi.fn(),
    configuration: {
      meterValuesSampledData: vi.fn(() => ["Current.Import"]),
    },
  } as unknown as ChargePoint;
}

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

describe("OCPPMessageHandlerV201.sendMeterValue phase passthrough (#301)", () => {
  it("carries the builder's L1/L2/L3 phase tag onto the wire payload", () => {
    const fakeSocket = new FakeSocket();
    const mockChargePoint = createMockChargePoint(threePhaseConnectorStub());
    const handler = new OCPPMessageHandlerV201(
      mockChargePoint,
      fakeSocket as unknown as OCPPWebSocket,
      createMockLogger(),
      new Map() as never,
    );

    handler.sendMeterValue(undefined, 1);

    const call = fakeSocket.sentCalls.find((c) => c.action === "MeterValues");
    expect(call).toBeDefined();
    const payload = call!.payload as MeterValuesRequestV201;
    const samples = payload.meterValue[0]!.sampledValue;

    const phases = samples
      .map((s) => s.phase)
      .filter((p): p is NonNullable<typeof p> => p !== undefined);
    expect(phases.sort()).toEqual(["L1", "L2", "L3"]);
    // The aggregate (no phase) must still be present alongside the three.
    expect(samples.some((s) => s.phase === undefined)).toBe(true);
  });
});
