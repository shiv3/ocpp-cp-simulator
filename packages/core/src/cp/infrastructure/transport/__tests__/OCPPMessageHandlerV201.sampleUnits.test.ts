import { describe, it, expect, vi } from "vitest";
import { OCPPMessageHandlerV201 } from "../OCPPMessageHandlerV201";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import type { Logger } from "../../../shared/Logger";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { MeterValuesRequestV201 } from "@ocpp-cp-sim/ocpp/index";
import { schemas } from "@ocpp-cp-sim/ocpp/index";
import { unitOfMeasurandV2x } from "../../../domain/connector/MeterValueBuilder";

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

// 2.1-only MeasurandEnumType values (#766). `undefined` = unitless
// (Display.ChargingComplete is 0/1, Display.InletHot a flag).
const APPENDIX_UNIT_V21: Record<string, string | undefined> = {
  "Current.Export.Offered": "A",
  "Current.Export.Minimum": "A",
  "Current.Import.Offered": "A",
  "Current.Import.Minimum": "A",
  "Display.PresentSOC": "Percent",
  "Display.MinimumSOC": "Percent",
  "Display.TargetSOC": "Percent",
  "Display.MaximumSOC": "Percent",
  "Display.RemainingTimeToMinimumSOC": "s",
  "Display.RemainingTimeToTargetSOC": "s",
  "Display.RemainingTimeToMaximumSOC": "s",
  "Display.ChargingComplete": undefined,
  "Display.BatteryEnergyCapacity": "Wh",
  "Display.InletHot": undefined,
  "Energy.Active.Import.CableLoss": "Wh",
  "Energy.Active.Import.LocalGeneration.Register": "Wh",
  "Energy.Active.Setpoint.Interval": "Wh",
  "EnergyRequest.Target": "Wh",
  "EnergyRequest.Minimum": "Wh",
  "EnergyRequest.Maximum": "Wh",
  "EnergyRequest.Minimum.V2X": "Wh",
  "EnergyRequest.Maximum.V2X": "Wh",
  "EnergyRequest.Bulk": "Wh",
  "Power.Active.Setpoint": "W",
  "Power.Active.Residual": "W",
  "Power.Export.Minimum": "W",
  "Power.Export.Offered": "W",
  "Power.Import.Offered": "W",
  "Power.Import.Minimum": "W",
  "Voltage.Minimum": "V",
  "Voltage.Maximum": "V",
};

function measurandEnumV21(): string[] {
  const schema = (schemas.v21 as Record<string, unknown>)
    .meterValuesRequestV21 as {
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

function sendAll(measurands: string[], ocppVersion?: string) {
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
    ...(ocppVersion ? { ocppVersion } : {}),
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
  // A measurand the builder does not model yields no CALL at all.
  if (!call) return [];
  return (call.payload as MeterValuesRequestV201).meterValue[0]!.sampledValue;
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

describe("OCPPMessageHandlerV201 sample units for the 2.1 measurands (#766)", () => {
  it("the tables together cover every value of the 2.1 MeasurandEnumType", () => {
    expect(
      [...Object.keys(APPENDIX_UNIT), ...Object.keys(APPENDIX_UNIT_V21)]
        .filter((m, i, all) => all.indexOf(m) === i)
        .sort(),
    ).toEqual([...measurandEnumV21()].sort());
  });

  it.each(Object.entries(APPENDIX_UNIT_V21))(
    "%s maps to its Appendix unit",
    (measurand, unit) => {
      expect(unitOfMeasurandV2x(measurand)).toBe(unit);
    },
  );

  it.each(Object.entries(APPENDIX_UNIT_V21))(
    "%s, when the builder emits a sample on a 2.1 station, carries its unit",
    (measurand, unit) => {
      for (const sample of sendAll([measurand], "OCPP-2.1")) {
        expect(sample.unitOfMeasure?.unit).toBe(unit);
      }
    },
  );
});
