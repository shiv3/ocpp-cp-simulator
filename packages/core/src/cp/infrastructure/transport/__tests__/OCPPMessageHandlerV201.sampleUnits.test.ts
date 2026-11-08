import { describe, it, expect, vi } from "vitest";
import { OCPPMessageHandlerV201 } from "../OCPPMessageHandlerV201";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import type { Logger } from "../../../shared/Logger";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { MeterValuesRequestV201 } from "@ocpp-cp-sim/ocpp/index";
import { schemas } from "@ocpp-cp-sim/ocpp/index";

// #713: OCPP 2.0.1 Part 2 Appendices ch. 2 - "Default value of unit is always
// Wh", so every 2.x sample except a unitless one must name its unit.

const APPENDIX_UNIT: Record<string, string | undefined> = {
  "Current.Export": "A",
  "Current.Import": "A",
  "Current.Offered": "A",
  "Energy.Active.Export.Register": "Wh",
  "Energy.Active.Import.Register": "Wh",
  "Energy.Reactive.Export.Register": "varh",
  "Energy.Reactive.Import.Register": "varh",
  "Energy.Active.Export.Interval": "Wh",
  "Energy.Active.Import.Interval": "Wh",
  "Energy.Active.Net": "Wh",
  "Energy.Reactive.Export.Interval": "varh",
  "Energy.Reactive.Import.Interval": "varh",
  "Energy.Reactive.Net": "varh",
  "Energy.Apparent.Net": "VAh",
  "Energy.Apparent.Import": "VAh",
  "Energy.Apparent.Export": "VAh",
  Frequency: "Hz",
  "Power.Active.Export": "W",
  "Power.Active.Import": "W",
  "Power.Factor": undefined,
  "Power.Offered": "W",
  "Power.Reactive.Export": "var",
  "Power.Reactive.Import": "var",
  SoC: "Percent",
  Voltage: "V",
};

function measurandEnum(): string[] {
  const schema = (schemas.v201 as Record<string, unknown>)
    .meterValuesRequestV201 as {
    definitions: { MeasurandEnumType: { enum: string[] } };
  };
  return schema.definitions.MeasurandEnumType.enum;
}

function connectorStub(): unknown {
  return {
    status: "Charging",
    soc: 50,
    meterValue: 1234,
    transaction: null,
    evSettings: {
      modelName: "Test EV",
      batteryCapacityKwh: 75,
      maxChargingPowerKw: 22,
      initialSoc: 20,
      targetSoc: 80,
      currentType: "AC",
      phases: 1,
      voltageV: 230,
    },
    currentScheduleLimitWatts: () => Infinity,
    activePhaseCount: () => 1,
    scheduleConstraints: () => ({ watts: Infinity, activePhases: 1 }),
  };
}

function sendAll(measurands: string[]) {
  const sent: Array<{ action: string; payload: unknown }> = [];
  const socket = {
    setMessageHandler() {},
    onCloseTransaction() {},
    isConnected: () => true,
    currentGeneration: () => ({ gen: 1, closeCause: null }),
    sendAction(
      _id: string,
      action: string,
      payload: unknown,
      _gen: unknown,
      onSettled?: (s: { outcome: string }) => void,
    ) {
      sent.push({ action, payload });
      onSettled?.({ outcome: "written" });
      return true;
    },
  };
  const chargePoint = {
    getConnector: vi.fn(() => connectorStub()),
    notifyOutgoingCall: vi.fn(),
    signedMeterFor: vi.fn(() => null),
    configuration: {
      meterValuesSampledData: vi.fn(() => measurands),
      messageTimeout: vi.fn(() => 30),
    },
  } as unknown as ChargePoint;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  const handler = new OCPPMessageHandlerV201(
    chargePoint,
    socket as unknown as OCPPWebSocket,
    logger,
    new Map() as never,
  );
  handler.sendMeterValue(undefined, 1, "Sample.Periodic", { measurands });
  const call = sent.find((c) => c.action === "MeterValues");
  return (call!.payload as MeterValuesRequestV201).meterValue[0]!.sampledValue;
}

describe("OCPPMessageHandlerV201 sample units (#713)", () => {
  it("the table covers every value of MeasurandEnumType", () => {
    expect(Object.keys(APPENDIX_UNIT).sort()).toEqual(
      [...measurandEnum()].sort(),
    );
  });

  it.each(Object.entries(APPENDIX_UNIT))(
    "%s carries its Appendix unit",
    (measurand, unit) => {
      const samples = sendAll([measurand]);
      expect(samples).toHaveLength(1);
      expect(samples[0]!.measurand).toBe(measurand);
      expect(samples[0]!.unitOfMeasure?.unit).toBe(unit);
      if (unit === undefined) expect(samples[0]!.unitOfMeasure).toBeUndefined();
    },
  );
});
