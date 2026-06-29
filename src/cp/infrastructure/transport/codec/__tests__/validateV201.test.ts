import { describe, expect, it } from "vitest";

import { outgoingV201Warning, validateV201Request } from "../validateV201";

describe("validateV201Request", () => {
  it("accepts a valid BootNotification request", () => {
    const payload = {
      reason: "PowerUp",
      chargingStation: { model: "M", vendorName: "V" },
    };

    expect(outgoingV201Warning("BootNotification", payload)).toBeNull();
    expect(validateV201Request("BootNotification", payload).valid).toBe(true);
  });

  it("rejects a BootNotification missing chargingStation", () => {
    const payload = { reason: "PowerUp" };
    const warning = outgoingV201Warning("BootNotification", payload);
    const result = validateV201Request("BootNotification", payload);

    expect(warning).toContain("failed v201 schema validation");
    expect(result.valid).toBe(false);
  });

  it("reports no validator for an unknown action", () => {
    const warning = outgoingV201Warning("NotARealAction", {});

    expect(warning).toContain("No v201 request validator");
  });
});
