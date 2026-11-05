import { describe, expect, it } from "vitest";

import { outgoingV21Warning, validateV21Request } from "../validateV21";

describe("validateV21Request", () => {
  it("accepts a valid BootNotification request", () => {
    const payload = {
      reason: "PowerUp",
      chargingStation: { model: "M", vendorName: "V" },
    };

    expect(outgoingV21Warning("BootNotification", payload)).toBeNull();
    expect(validateV21Request("BootNotification", payload).valid).toBe(true);
  });

  it("rejects a BootNotification missing chargingStation", () => {
    const payload = { reason: "PowerUp" };
    const warning = outgoingV21Warning("BootNotification", payload);
    const result = validateV21Request("BootNotification", payload);

    expect(warning).toContain("failed v21 schema validation");
    expect(result.valid).toBe(false);
  });

  it("reports no validator for an unknown action", () => {
    const warning = outgoingV21Warning("NotARealAction", {});

    expect(warning).toContain("No v21 request validator");
  });
});
