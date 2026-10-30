import { describe, expect, it } from "vitest";

import {
  formatVersionLabel,
  LOCAL_DEV_VERSION,
  resolveBuildVersion,
} from "../buildVersion";

const SHA = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";

describe("resolveBuildVersion", () => {
  it.each([
    ["a stamped release", { packageVersion: "1.2.3" }, "1.2.3"],
    [
      "a stamped release over the commit",
      { packageVersion: "1.2.3", commit: SHA },
      "1.2.3",
    ],
    [
      "an explicit stamp over everything",
      { explicit: " 4.5.6 ", packageVersion: "1.2.3", commit: SHA },
      "4.5.6",
    ],
    [
      "a blank explicit stamp falls through",
      { explicit: "   ", packageVersion: "0.0.0", commit: SHA },
      "1a2b3c4-dev",
    ],
    [
      "the short commit for a deployed unstamped build",
      { packageVersion: "0.0.0", commit: SHA },
      "1a2b3c4-dev",
    ],
    [
      "an already short commit as is",
      { packageVersion: "0.0.0", commit: "abcdef1" },
      "abcdef1-dev",
    ],
    [
      "local-dev when no commit is stamped",
      { packageVersion: "0.0.0" },
      LOCAL_DEV_VERSION,
    ],
    // Docker turns an unset build arg into `ENV APP_COMMIT=` (empty).
    [
      "local-dev for an empty commit",
      { packageVersion: "0.0.0", commit: "" },
      LOCAL_DEV_VERSION,
    ],
    [
      "local-dev for a whitespace commit",
      { packageVersion: " 0.0.0 ", commit: "  " },
      LOCAL_DEV_VERSION,
    ],
  ])("resolves %s", (_case, input, expected) => {
    expect(resolveBuildVersion(input)).toBe(expected);
  });
});

describe("formatVersionLabel", () => {
  it.each([
    ["1.2.3", "v1.2.3"],
    ["1.2.3-rc.1", "v1.2.3-rc.1"],
    ["1.2.3+build.5", "v1.2.3+build.5"],
    // Only a whole semver gets the prefix, not a string that starts like one.
    ["1.2.3broken", "1.2.3broken"],
    ["1.2.3.4", "1.2.3.4"],
    ["0.0.0-dev", "v0.0.0-dev"],
    // A short SHA can start with a digit; it is not a semver.
    ["1234567-dev", "1234567-dev"],
    ["1a2b3c4-dev", "1a2b3c4-dev"],
    [LOCAL_DEV_VERSION, LOCAL_DEV_VERSION],
  ])("labels %s as %s", (version, expected) => {
    expect(formatVersionLabel(version)).toBe(expected);
  });
});
