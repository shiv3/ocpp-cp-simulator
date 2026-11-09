import { describe, expect, it } from "vitest";

import { summarizeValue } from "./scenarioSteps";

describe("summarizeValue", () => {
  it("reads a $from reference as a path, a constant as its JSON", () => {
    expect(summarizeValue({ $from: "response.payload.idTagInfo.status" })).toBe(
      "$from response.payload.idTagInfo.status",
    );
    expect(summarizeValue("a")).toBe('"a"');
    expect(summarizeValue(3)).toBe("3");
    expect(summarizeValue(undefined)).toBe("");
  });
});
