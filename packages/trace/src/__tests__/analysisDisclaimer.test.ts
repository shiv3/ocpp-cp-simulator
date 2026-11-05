import { describe, expect, it } from "vitest";
import { ANALYZE_DISCLAIMER } from "../analysisDisclaimer";

describe("ANALYZE_DISCLAIMER", () => {
  it("is the issue #188 PoC item 8 compliance disclaimer text", () => {
    expect(ANALYZE_DISCLAIMER).toBe(
      'Failure-pattern detection is not OCPP compliance certification: "no known failure detected" does not mean "OCPP compliant".',
    );
  });
});
