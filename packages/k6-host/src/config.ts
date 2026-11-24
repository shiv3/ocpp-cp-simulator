// The environment of a generated load test, parsed and validated; and the k6
// `options` derived from it. Pure: the generated script.js passes `__ENV`.
import type { Profile } from "./charger";
import { parseDurationSeconds, vusFor } from "./ids";

export interface FleetConfig {
  readonly csmsUrl: string;
  readonly chargers: number;
  readonly chargersPerVu: number;
  readonly profile: Profile;
  readonly durationSeconds: number;
  readonly rampSeconds: number;
  readonly prefix: string;
  readonly pad: number;
  readonly offset: number;
  /** JSON file of `{ cpId, basicPassword? }`, indexed by charger index. */
  readonly idsFile?: string;
  readonly basicPassword?: string;
  readonly seed?: string;
  readonly meterValueSampleIntervalS?: number;
  readonly ocppVersion: "1.6";
}

type Env = Readonly<Record<string, string | undefined>>;

function str(env: Env, name: string): string | undefined {
  const v = env[name];
  return v === undefined || v === "" ? undefined : v;
}

function int(env: Env, name: string, fallback: number, min: number): number {
  const v = str(env, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${name} must be an integer >= ${min} (got "${v}")`);
  }
  return n;
}

export function readFleetConfig(env: Env): FleetConfig {
  const csmsUrl = str(env, "CSMS_URL");
  if (csmsUrl === undefined)
    throw new Error("missing required env var CSMS_URL");
  if (!/^wss?:\/\//.test(csmsUrl)) {
    throw new Error(
      `CSMS_URL must start with ws:// or wss:// (got "${csmsUrl}")`,
    );
  }
  const profile = str(env, "PROFILE") ?? "steady";
  if (profile !== "steady" && profile !== "once" && profile !== "soak") {
    throw new Error(`PROFILE must be steady, once or soak (got "${profile}")`);
  }
  const version = str(env, "OCPP_VERSION") ?? "1.6";
  if (version !== "1.6") {
    throw new Error(
      `OCPP_VERSION ${version} is not supported: this export runs OCPP 1.6J only`,
    );
  }
  const meter = str(env, "METER_VALUE_SAMPLE_INTERVAL");
  return {
    csmsUrl,
    chargers: int(env, "CHARGERS", 10, 1),
    chargersPerVu: int(env, "CHARGERS_PER_VU", 50, 1),
    profile,
    durationSeconds: parseDurationSeconds(str(env, "DURATION") ?? "5m"),
    rampSeconds: parseDurationSeconds(str(env, "RAMP_DURATION") ?? "30s"),
    prefix: str(env, "CP_ID_PREFIX") ?? "CP-",
    pad: int(env, "CP_ID_PAD", 5, 1),
    offset: int(env, "CP_ID_OFFSET", 0, 0),
    ...(str(env, "CP_IDS_FILE") ? { idsFile: str(env, "CP_IDS_FILE")! } : {}),
    ...(str(env, "BASIC_AUTH_PASSWORD")
      ? { basicPassword: str(env, "BASIC_AUTH_PASSWORD")! }
      : {}),
    ...(str(env, "SEED") ? { seed: str(env, "SEED")! } : {}),
    ...(meter
      ? {
          meterValueSampleIntervalS: int(
            env,
            "METER_VALUE_SAMPLE_INTERVAL",
            0,
            1,
          ),
        }
      : {}),
    ocppVersion: "1.6",
  };
}

/** Seconds a VU may run past the test duration before k6 interrupts it. */
export const GRACEFUL_STOP_SECONDS = 30;

/**
 * The k6 `options`: one iteration per VU, each VU drives `chargersPerVu`
 * chargers. `vus` is the whole test's; `--execution-segment` splits it.
 */
export function k6Options(
  config: FleetConfig,
  hasScenario: boolean,
): Record<string, unknown> {
  const vus = vusFor(config);
  const maxSeconds = Math.ceil(
    config.rampSeconds + config.durationSeconds + GRACEFUL_STOP_SECONDS + 30,
  );
  return {
    scenarios: {
      chargers: {
        executor: "per-vu-iterations",
        vus,
        iterations: 1,
        maxDuration: `${maxSeconds}s`,
        gracefulStop: `${GRACEFUL_STOP_SECONDS}s`,
      },
    },
    // A rate without samples would fail its threshold.
    ...(hasScenario ? { thresholds: { scenario_success: ["rate>0.99"] } } : {}),
    summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "max", "count"],
  };
}
