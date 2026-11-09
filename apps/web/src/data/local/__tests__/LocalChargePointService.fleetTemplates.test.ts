import { describe, expect, it } from "vitest";

import { UnsupportedFeatureError } from "@ocpp-cp-simulator/client/interfaces/UnsupportedFeatureError";
import { LocalChargePointService } from "../LocalChargePointService";

// #445: fleet templates belong to the daemon; the browser simulator refuses
// every call rather than show a list that could never be filled.
describe("LocalChargePointService fleet templates", () => {
  it.each([
    [
      "listFleetTemplates",
      (s: LocalChargePointService) => s.listFleetTemplates(),
    ],
    [
      "getFleetTemplate",
      (s: LocalChargePointService) => s.getFleetTemplate("x"),
    ],
    [
      "deleteFleetTemplate",
      (s: LocalChargePointService) => s.deleteFleetTemplate("x"),
    ],
    [
      "createFleet",
      (s: LocalChargePointService) => s.createFleet({ templateId: "x" }),
    ],
  ])("%s rejects as unsupported in browser mode", async (_name, call) => {
    const attempt = call(new LocalChargePointService());
    await expect(attempt).rejects.toBeInstanceOf(UnsupportedFeatureError);
    await expect(attempt).rejects.toMatchObject({
      code: "browser_fleet_templates_unsupported",
    });
  });
});
