import { describe, expect, it } from "vitest";

import { UnsupportedFeatureError } from "../../interfaces/UnsupportedFeatureError";
import { LocalChargePointService } from "../LocalChargePointService";

// #471: labels (#446) belong to daemon charge points; a local one has none, so
// a relabel is refused rather than reported as a success that stored nothing.
describe("LocalChargePointService labels", () => {
  it("setChargePointLabels rejects as unsupported in browser mode", async () => {
    const service = new LocalChargePointService();

    const attempt = service.setChargePointLabels("CP-1", { site: "s1" });

    await expect(attempt).rejects.toBeInstanceOf(UnsupportedFeatureError);
    await expect(attempt).rejects.toMatchObject({
      code: "browser_labels_unsupported",
    });
  });
});
