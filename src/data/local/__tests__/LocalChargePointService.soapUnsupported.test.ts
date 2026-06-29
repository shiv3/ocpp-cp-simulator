import { describe, expect, it } from "vitest";

import { DefaultBootNotification } from "../../../cp/domain/types/OcppTypes";
import { UnsupportedFeatureError } from "../../../cp/domain/errors/UnsupportedFeatureError";
import { LocalChargePointService } from "../LocalChargePointService";

describe("LocalChargePointService SOAP guard", () => {
  it("rejects OCPP 1.5 SOAP in browser/local mode", async () => {
    const service = new LocalChargePointService();

    await expect(
      service.syncLocalChargePoints([
        {
          id: "CP-SOAP",
          connectorNumber: 1,
          bootNotification: DefaultBootNotification,
          wsUrl: "http://127.0.0.1:8180/steve/services/CentralSystemService",
          basicAuth: null,
          autoMeterValueSetting: null,
          ocppVersion: "OCPP-1.5",
        },
      ]),
    ).rejects.toThrow(UnsupportedFeatureError);
  });
});
