import { describe, expect, it } from "vitest";

import { defaultAutoTrafficConfig } from "../../../cp/domain/connector/AutoTraffic";
import { UnsupportedFeatureError } from "../../interfaces/UnsupportedFeatureError";
import { LocalChargePointService } from "../LocalChargePointService";

// #374: ChargePointService declares the auto-traffic methods (#300), but only
// the daemon runs AutoTrafficRunner and LocalChargePointService did not
// implement them at all, so a browser-mode caller got "is not a function".
describe("LocalChargePointService auto traffic", () => {
  const config = { ...defaultAutoTrafficConfig, enabled: true };

  it.each(["setAutoTrafficConfig", "saveAutoTrafficConfig"] as const)(
    "%s rejects as unsupported in browser mode",
    async (method) => {
      const service = new LocalChargePointService();

      const attempt = service[method]("CP-1", 1, config);

      await expect(attempt).rejects.toBeInstanceOf(UnsupportedFeatureError);
      await expect(attempt).rejects.toMatchObject({
        code: "browser_auto_traffic_unsupported",
      });
    },
  );

  it("reads no stored config for a connector", async () => {
    const service = new LocalChargePointService();

    await expect(service.getAutoTrafficConfig("CP-1", 1)).resolves.toBeNull();
  });
});
