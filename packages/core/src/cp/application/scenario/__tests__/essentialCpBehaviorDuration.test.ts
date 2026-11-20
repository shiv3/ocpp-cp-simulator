import { describe, expect, it } from "vitest";

import { getTemplateById } from "../../../../utils/scenarioTemplates";

/**
 * `essential-cp-behavior` charges until the EV's target SoC (its Auto
 * MeterValue node has `stopMode: "evSettings"`) and only then waits for the
 * CSMS's RemoteStopTransaction. With a 75 kWh EV at 20 % -> 80 % and 50 kW
 * that takes 54 minutes of wall clock, so run headless the scenario never got
 * to its RemoteStop trigger. The scenario carries its own `evSettings`, sized
 * so the charge to the target ends within two minutes at the node's output.
 */
describe("essential-cp-behavior duration", () => {
  it("reaches the EV target SoC within two minutes at the meter node's output", () => {
    const template = getTemplateById("essential-cp-behavior");
    expect(template).toBeDefined();
    const scenario = template!.createScenario("cp", 1);
    const ev = scenario.evSettings!;
    const meter = scenario.nodes.find((n) => n.type === "meterValue")!;
    const data = meter.data as { outputKw: number; stopMode: string };
    expect(data.stopMode).toBe("evSettings");

    const kwh =
      (ev.batteryCapacityKwh! * (ev.targetSoc! - ev.initialSoc!)) / 100;
    const seconds =
      (kwh / Math.min(data.outputKw, ev.maxChargingPowerKw!)) * 3600;
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(120);
  });
});
