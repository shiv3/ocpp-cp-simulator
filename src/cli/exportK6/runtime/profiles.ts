// src/cli/exportK6/runtime/profiles.ts
// Env-driven k6 options. PROFILE selects the executor shape; VUS/DURATION/
// RAMP_DURATION tune it. Soak keeps each VU's connection alive after the
// scenario (see the generated entry's cp.hold()).

export function buildOptions(
  env: Record<string, string | undefined>,
): Record<string, unknown> {
  const profile = env.PROFILE ?? "steady";
  const vus = Number.parseInt(env.VUS ?? "5", 10);
  const ramp = env.RAMP_DURATION ?? "1m";
  const thresholds = { scenario_success: ["rate>0.99"] };
  switch (profile) {
    case "steady":
      return {
        thresholds,
        scenarios: {
          steady: {
            executor: "constant-vus",
            vus,
            duration: env.DURATION ?? "5m",
          },
        },
      };
    case "spike":
      return {
        thresholds,
        scenarios: {
          spike: {
            executor: "ramping-vus",
            startVUs: 0,
            stages: [
              { duration: ramp, target: vus },
              { duration: env.DURATION ?? "5m", target: vus },
              { duration: "30s", target: 0 },
            ],
            gracefulRampDown: "30s",
          },
        },
      };
    case "soak":
      return {
        thresholds,
        scenarios: {
          soak: {
            executor: "constant-vus",
            vus,
            duration: env.DURATION ?? "1h",
          },
        },
      };
    default:
      throw new Error(
        `Unknown PROFILE "${profile}" (expected spike, steady, or soak)`,
      );
  }
}
