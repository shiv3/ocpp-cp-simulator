import { describe, expect, it } from "vitest";

import { resolveBuildLabel } from "./appBuildLabel";

describe("resolveBuildLabel", () => {
  it.each([
    ["a stamped release", "1.2.3", "", "v1.2.3"],
    ["a stamped release over the commit", "1.2.3", "abcdef1", "v1.2.3"],
    ["the commit for an unstamped Pages build", "0.0.0", "abcdef1", "abcdef1"],
    ["nothing for an unstamped dev build", "0.0.0", "", null],
  ])("shows %s", (_case, version, commit, expected) => {
    expect(resolveBuildLabel(version, commit)).toBe(expected);
  });
});
