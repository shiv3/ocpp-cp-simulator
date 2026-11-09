import { describe, expect, it } from "vitest";

import type { SampledValue } from "../../../../domain/connector/MeterValueBuilder";
import {
  idTagInfoFromPayload,
  numericValue,
  textValue,
  toOcpp15MeterSample,
  toOcpp16SampledValue,
} from "../soapConverters";

describe("SOAP response converters", () => {
  it("reads scalar text values and nothing else", () => {
    expect(textValue("abc")).toBe("abc");
    expect(textValue(42)).toBe("42");
    expect(textValue(true)).toBe("true");
    expect(textValue({ nested: "x" })).toBeUndefined();
    expect(textValue(undefined)).toBeUndefined();
  });

  it("reads finite numbers and rejects blank or non-numeric text", () => {
    expect(numericValue("300")).toBe(300);
    expect(numericValue(12)).toBe(12);
    expect(numericValue("")).toBeUndefined();
    expect(numericValue("  ")).toBeUndefined();
    expect(numericValue("abc")).toBeUndefined();
    expect(numericValue(undefined)).toBeUndefined();
  });

  it("maps an unknown idTagInfo status to Invalid", () => {
    expect(idTagInfoFromPayload({ status: "Whatever" })).toEqual({
      status: "Invalid",
    });
    expect(idTagInfoFromPayload(undefined)).toEqual({ status: "Invalid" });
  });

  it("keeps a known idTagInfo status with its optional fields", () => {
    expect(
      idTagInfoFromPayload({
        status: "ConcurrentTx",
        expiryDate: "2030-01-01T00:00:00.000Z",
        parentIdTag: "PARENT",
      }),
    ).toEqual({
      status: "ConcurrentTx",
      expiryDate: "2030-01-01T00:00:00.000Z",
      parentIdTag: "PARENT",
    });
  });
});

describe("OCPP 1.5 meter sample mapping", () => {
  it("maps units to their 1.5 spelling", () => {
    const unitOf = (unit: string) =>
      toOcpp15MeterSample({ value: "1", unit })?.["@_unit"];
    expect(unitOf("A")).toBe("Amp");
    expect(unitOf("V")).toBe("Volt");
    expect(unitOf("Celcius")).toBe("Celsius");
    expect(unitOf("Wh")).toBe("Wh");
    expect(unitOf("Percent")).toBeUndefined();
  });

  it("drops the Offered measurands and per-phase samples", () => {
    expect(
      toOcpp15MeterSample({ value: "1", measurand: "Power.Offered" }),
    ).toBeNull();
    expect(
      toOcpp15MeterSample({ value: "1", measurand: "Current.Offered" }),
    ).toBeNull();
    expect(
      toOcpp15MeterSample({
        value: "1",
        measurand: "Current.Import",
        phase: "L1",
      }),
    ).toBeNull();
  });

  it("drops a context 1.5 does not define, keeping the sample", () => {
    expect(
      toOcpp15MeterSample({ value: "1", context: "Trigger" }),
    ).toStrictEqual({ "#text": "1" });
  });

  it("emits the attributes in wire order", () => {
    const sample: SampledValue = {
      unit: "Wh",
      location: "Outlet",
      measurand: "Energy.Active.Import.Register",
      format: "Raw",
      context: "Sample.Periodic",
      value: "1234",
    };
    const mapped = toOcpp15MeterSample(sample);
    expect(mapped).not.toBeNull();
    expect(Object.keys(mapped!)).toEqual([
      "#text",
      "@_context",
      "@_format",
      "@_measurand",
      "@_location",
      "@_unit",
    ]);
  });
});

describe("OCPP 1.6 SOAP sampled value mapping", () => {
  it("passes every field through as child elements, in wire order", () => {
    const sample: SampledValue = {
      unit: "A",
      location: "Outlet",
      phase: "L2",
      measurand: "Current.Offered",
      format: "Raw",
      context: "Trigger",
      value: "16",
    };
    const mapped = toOcpp16SampledValue(sample);
    expect(Object.keys(mapped)).toEqual([
      "value",
      "context",
      "format",
      "measurand",
      "phase",
      "location",
      "unit",
    ]);
    expect(mapped).toEqual({
      value: "16",
      context: "Trigger",
      format: "Raw",
      measurand: "Current.Offered",
      phase: "L2",
      location: "Outlet",
      unit: "A",
    });
  });

  it("omits the optional fields a sample does not set", () => {
    expect(toOcpp16SampledValue({ value: "5" })).toStrictEqual({ value: "5" });
  });
});
