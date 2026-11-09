import { describe, expect, it } from "bun:test";

import { FakeCsms } from "./FakeCsms";

describe("FakeCsms case deadline (#848)", () => {
  it("cuts every budget down to what is left of the case deadline", () => {
    const csms = Object.create(FakeCsms.prototype) as FakeCsms;
    expect(csms.budget(60_000)).toBe(60_000);
    csms.caseDeadline = Date.now() + 1_000;
    expect(csms.budget(60_000)).toBeLessThanOrEqual(1_000);
    csms.caseDeadline = Date.now() - 1;
    expect(csms.budget(60_000)).toBe(0);
  });
});
