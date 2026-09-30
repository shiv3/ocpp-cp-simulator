import { describe, expect, it } from "vitest";

import { formatEnergyKwh, formatSoc } from "./connectorFormat";

describe("formatEnergyKwh", () => {
  it.each([
    [16208, "16.21 kWh"],
    [0, "0.00 kWh"],
    [999, "1.00 kWh"],
  ])("formats %s Wh as %s", (wh, expected) => {
    expect(formatEnergyKwh(wh)).toBe(expected);
  });
});

describe("formatSoc", () => {
  it.each([
    [20.462666666666667, "20.5%"],
    [80, "80.0%"],
    [0, "0.0%"],
  ])("formats %s as %s", (soc, expected) => {
    expect(formatSoc(soc)).toBe(expected);
  });
});
