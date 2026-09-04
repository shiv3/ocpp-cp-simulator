import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { OCPPMessageHandler } from "../OCPPMessageHandler";
import { Logger, LogLevel } from "../../../shared/Logger";
import type { ProtocolCodec } from "../profile/ProtocolProfile";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { GenerationToken, Settlement } from "../network-sim";
import type { MeterValuesRequestV16 } from "../../../../ocpp";

/**
 * Regression for #301 finding 1 on OCPP 1.6-J: `sendMeterValue` casts the
 * builder's whole `SampledValue[]` onto the wire type rather than remapping
 * field-by-field, so the `phase` tag (L1/L2/L3) the builder attaches on a
 * 3-phase AC connector already survives today. This locks that in so a
 * future refactor to a field-by-field copy (as V201's handler does) can't
 * silently drop it the way V201's originally did.
 */

class FakeSocket implements Partial<OCPPWebSocket> {
  private _currentGen: GenerationToken = { gen: 0, closeCause: null };

  setMessageHandler(): void {}
  currentGeneration(): GenerationToken {
    return this._currentGen;
  }
  isConnected(): boolean {
    return true;
  }
  sendAction(
    _messageId: string,
    _action: string,
    _payload: unknown,
    _gen?: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): boolean {
    onSettled?.({ outcome: "written" });
    return true;
  }
}

class MockChargePoint {
  id = "TEST-CP";
  database: unknown = null;
  configuration = {
    transactionMessageAttempts: () => 3,
    meterValuesSampledData: () => ["Current.Import"],
  };
  notifyOutgoingCall(): void {}
  notifyIncomingCall(): void {}
  consumeResponseOverride(): string | null {
    return null;
  }
  getConnector(): unknown {
    return {
      status: "Charging",
      soc: 50,
      meterValue: 1000,
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
    };
  }
  cleanTransaction(): void {}
  updateConnectorStatus(): void {}
  notifyAuthorizeResult(): void {}
}

class MockCodec implements Partial<ProtocolCodec> {
  outgoingWarning(): string | null {
    return null;
  }
}

describe("OCPPMessageHandler.sendMeterValue phase passthrough (1.6-J, #301)", () => {
  let fakeSocket: FakeSocket;
  let handler: OCPPMessageHandler;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeSocket = new FakeSocket();
    handler = new OCPPMessageHandler(
      new MockChargePoint() as unknown as ChargePoint,
      fakeSocket as unknown as OCPPWebSocket,
      new Logger(LogLevel.DEBUG),
      new MockCodec() as unknown as ProtocolCodec,
    );
    handler.setBootStatus({ status: "Accepted" });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("carries the builder's L1/L2/L3 phase tag onto the wire payload", async () => {
    let captured: MeterValuesRequestV16 | undefined;
    fakeSocket.sendAction = (
      _id: string,
      action: string,
      payload: unknown,
      _gen?: GenerationToken,
      onSettled?: (s: Settlement) => void,
    ): boolean => {
      if (action === "MeterValues") captured = payload as MeterValuesRequestV16;
      onSettled?.({ outcome: "written" });
      return true;
    };

    handler.sendMeterValue(undefined, 1);

    expect(captured).toBeDefined();
    const samples = captured!.meterValue[0]!.sampledValue as Array<{
      phase?: string;
    }>;
    const phases = samples
      .map((s) => s.phase)
      .filter((p): p is string => p !== undefined);
    expect(phases.sort()).toEqual(["L1", "L2", "L3"]);
    expect(samples.some((s) => s.phase === undefined)).toBe(true);
  });
});
