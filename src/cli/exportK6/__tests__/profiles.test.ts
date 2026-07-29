// src/cli/exportK6/__tests__/profiles.test.ts
import { describe, expect, it } from "vitest";
import { buildOptions } from "../runtime/profiles";

describe("buildOptions", () => {
  it("defaults to a small steady profile with a success threshold", () => {
    expect(buildOptions({})).toEqual({
      thresholds: { scenario_success: ["rate>0.99"] },
      scenarios: {
        steady: { executor: "constant-vus", vus: 5, duration: "5m" },
      },
    });
  });

  it("honors VUS and DURATION overrides", () => {
    const opts = buildOptions({
      PROFILE: "steady",
      VUS: "200",
      DURATION: "10m",
    });
    expect(opts.scenarios).toEqual({
      steady: { executor: "constant-vus", vus: 200, duration: "10m" },
    });
  });

  it("builds a ramping spike profile", () => {
    expect(
      buildOptions({ PROFILE: "spike", VUS: "1000", RAMP_DURATION: "2m" })
        .scenarios,
    ).toEqual({
      spike: {
        executor: "ramping-vus",
        startVUs: 0,
        stages: [
          { duration: "2m", target: 1000 },
          { duration: "5m", target: 1000 },
          { duration: "30s", target: 0 },
        ],
        gracefulRampDown: "30s",
      },
    });
  });

  it("builds a long soak profile by default duration", () => {
    expect(buildOptions({ PROFILE: "soak", VUS: "50" }).scenarios).toEqual({
      soak: { executor: "constant-vus", vus: 50, duration: "1h" },
    });
  });

  it("rejects an unknown profile", () => {
    expect(() => buildOptions({ PROFILE: "nope" })).toThrow(/PROFILE/);
  });
});
