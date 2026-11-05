import { describe, expect, it } from "vitest";

import { ALL_CHARGE_POINT_ERROR_CODES, FAULT_ERROR_CODES } from "../OcppTypes";

describe("FAULT_ERROR_CODES (#441)", () => {
  it("offers every error code but NoError, in the same order", () => {
    expect(FAULT_ERROR_CODES).toEqual(
      ALL_CHARGE_POINT_ERROR_CODES.filter((code) => code !== "NoError"),
    );
    expect(FAULT_ERROR_CODES).toHaveLength(
      ALL_CHARGE_POINT_ERROR_CODES.length - 1,
    );
    expect(FAULT_ERROR_CODES).not.toContain("NoError");
  });
});
