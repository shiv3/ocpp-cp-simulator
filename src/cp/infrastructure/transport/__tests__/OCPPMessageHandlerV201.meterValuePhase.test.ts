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
    // One resolve, one instant (#301).
    scheduleConstraints: () => ({ watts: Infinity, activePhases: 3 }),
  };
}

function createMockChargePoint(connector: unknown): ChargePoint {
  return {
    getConnector: vi.fn(() => connector),
    notifyOutgoingCall: vi.fn(),
    // Signed meter data (#315) off, as by default.
    signedMeterFor: vi.fn(() => null),
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

// #454: a clock-aligned sample reports the aligned measurands at the
// boundary instant, not MeterValuesSampledData at "now".
describe("OCPPMessageHandlerV201 clock-aligned overrides (#454)", () => {
  const boundary = new Date("2026-10-28T12:15:00Z");

  function makeHandler(connector: unknown) {
    const fakeSocket = new FakeSocket();
    const handler = new OCPPMessageHandlerV201(
      createMockChargePoint(connector),
      fakeSocket as unknown as OCPPWebSocket,
      createMockLogger(),
      new Map() as never,
    );
    return { fakeSocket, handler };
  }

  it("MeterValuesRequest honours measurand and timestamp overrides", () => {
    const { fakeSocket, handler } = makeHandler(threePhaseConnectorStub());

    handler.sendMeterValue(undefined, 1, "Sample.Clock", {
      measurands: ["Energy.Active.Import.Register"],
      timestamp: boundary,
    });

    const payload = fakeSocket.sentCalls.find(
      (c) => c.action === "MeterValues",
    )!.payload as MeterValuesRequestV201;
    expect(payload.meterValue).toEqual([
      {
        timestamp: "2026-10-28T12:15:00.000Z",
        sampledValue: [
          expect.objectContaining({
            measurand: "Energy.Active.Import.Register",
            context: "Sample.Clock",
          }),
        ],
      },
    ]);
  });

  it("TransactionEvent(Updated) honours measurand and timestamp overrides", () => {
    const connector = {
      ...(threePhaseConnectorStub() as object),
      transaction: { stopTime: null, cpTransactionId: "tx-1", cpNextSeqNo: 3 },
      markTransactionChanged: vi.fn(),
    };
    const { fakeSocket, handler } = makeHandler(connector);

    handler.sendTransactionUpdate(1, {
      triggerReason: "MeterValueClock",
      meterValues: true,
      context: "Sample.Clock",
      measurands: ["Energy.Active.Import.Register"],
      timestamp: boundary,
    });

    const payload = fakeSocket.sentCalls.find(
      (c) => c.action === "TransactionEvent",
    )!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      eventType: "Updated",
      triggerReason: "MeterValueClock",
      timestamp: "2026-10-28T12:15:00.000Z",
      seqNo: 3,
      meterValue: [
        {
          timestamp: "2026-10-28T12:15:00.000Z",
          sampledValue: [
            expect.objectContaining({
              measurand: "Energy.Active.Import.Register",
              context: "Sample.Clock",
            }),
          ],
        },
      ],
    });
    expect(
      (payload.meterValue as { sampledValue: unknown[] }[])[0]!.sampledValue,
    ).toHaveLength(1);
  });
});
