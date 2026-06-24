import { describe, it, expect } from "vitest";
import { validateV16Request } from "../validateV16";

describe("validateV16Request", () => {
  it("accepts a valid BootNotification request", () => {
    const r = validateV16Request("BootNotification", {
      chargePointVendor: "Vendor",
      chargePointModel: "Model",
    });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("rejects a BootNotification missing a required field", () => {
    const r = validateV16Request("BootNotification", { chargePointVendor: "Vendor" });
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("reports no validator for an unknown action", () => {
    const r = validateV16Request("TotallyUnknownAction", {});
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("No v16 request validator");
  });
});
