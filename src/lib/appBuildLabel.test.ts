import { describe, expect, it } from "vitest";

import { resolveBuildLabel } from "./appBuildLabel";

describe("resolveBuildLabel", () => {
  it.each([
    ["a stamped release", "1.2.3", "", "v1.2.3"],
    ["a stamped release over the commit", "1.2.3", "abcdef1", "v1.2.3"],
    [
      "the short commit for an unstamped deployed build",
      "0.0.0",
      "abcdef1234567890",
      "abcdef1-dev",
    ],
    ["local-dev for an unstamped local build", "0.0.0", "", "local-dev"],
  ])("shows %s", (_case, version, commit, expected) => {
    expect(resolveBuildLabel(version, commit)).toBe(expected);
  });
});
