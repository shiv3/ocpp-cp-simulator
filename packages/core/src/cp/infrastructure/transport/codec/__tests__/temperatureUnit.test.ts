import { describe, expect, it } from "vitest";
import { Connector } from "../../../../domain/connector/Connector";
import {
  buildSampledValues,
  toOcppJ16Wire,
} from "../../../../domain/connector/MeterValueBuilder";
import { Logger, LogLevel } from "../../../../shared/Logger";
import { validateV16Request } from "../validateV16";

// OCPP-J 1.6 errata (2025-04) §2.1 (#745): the 1.6J wire keeps the original
// `Celcius` spelling; the builder (shared with OCPP-S and 2.x) says `Celsius`.
describe("Temperature unit spelling", () => {
  const connector = new Connector(1, new Logger(LogLevel.ERROR));
  const samples = buildSampledValues(connector, ["Temperature"], "Trigger");

  it("the shared builder spells Celsius (OCPP-S 1.6 and 2.x keep it)", () => {
    expect(samples.map((s) => s.unit)).toEqual(["Celsius"]);
  });

  it("the 1.6J wire spelling is Celcius and validates against the 1.6 schema", () => {
    const wire = toOcppJ16Wire(samples);
    expect(wire.map((s) => s.unit)).toEqual(["Celcius"]);
    const result = validateV16Request("MeterValues", {
      connectorId: 1,
      meterValue: [
        { timestamp: "2026-11-08T00:00:00.000Z", sampledValue: wire },
      ],
    });
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("leaves other units and the input untouched", () => {
    const mixed = buildSampledValues(
      connector,
      ["Energy.Active.Import.Register", "Temperature"],
      "Trigger",
    );
    const wire = toOcppJ16Wire(mixed);
    expect(wire.map((s) => s.unit)).toEqual(["Wh", "Celcius"]);
    expect(mixed.map((s) => s.unit)).toEqual(["Wh", "Celsius"]);
  });
});
