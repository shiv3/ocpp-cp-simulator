// src/cli/exportK6/runtime/profiles.ts
// Env-driven k6 options. PROFILE selects the executor shape; VUS/DURATION/
// RAMP_DURATION tune it. Soak keeps each VU's connection alive after the
// scenario (see the generated entry's cp.hold()).

export function buildOptions(
  env: Record<string, string | undefined>,
): Record<string, unknown> {
  const profile = env.PROFILE ?? "steady";
  const vus = parsePositiveInt(env.VUS ?? "5", "VUS");
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

/** Strict positive-integer parse: rejects "0", negative values, decimals, and
 * trailing garbage (e.g. "10oops") that Number.parseInt would silently accept. */
function parsePositiveInt(raw: string, name: string): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`Invalid ${name} "${raw}" (expected a positive integer)`);
  }
  return Number.parseInt(raw, 10);
}
