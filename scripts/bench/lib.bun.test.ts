// Unit tests for the pure logic in lib.ts — flag validation, the Prometheus
// exposition parser, and histogram diffing/quantile math. Runs under `bun
// test` (picked up by `bun.test` name filter, see package.json's `test:bun`).
import { describe, expect, it } from "bun:test";
import {
  benchIdPattern,
  BENCH_ID_ROOT,
  newRunId,
  BENCH_OCPP_VERSIONS,
  BenchAbortError,
  STEP_COLUMNS,
  TransactionStarts,
  BenchValidationError,
  CALL_WATCHDOG_SEC,
  MAX_FLEET_SIZE,
  MAX_ID_TAG_LENGTH,
  MAX_SOCKETS,
  MAX_SWEEP_POINTS,
  MAX_WARMUP_SEC,
  RPC_HEADROOM,
  RPC_RATE_PER_SOCKET,
  Semaphore,
  TokenBucket,
  answeredAfterWatchdog,
  assertDaemonEmpty,
  ASSIGNED_ID_TIMEOUT_MS,
  AUTHORIZE_WAIT_SEC,
  benchCpId,
  benchIdTag,
  cleanupIdsAfterBatch,
  createFailureHint,
  cycleBoundMs,
  cyclePeriodSec,
  daemonIsLocal,
  droppedDuringWindow,
  firstCycleDelayMs,
  diffHistogram,
  fleetGauge,
  formatSeconds,
  formatTable,
  histogramQuantile,
  mergeHistogramDeltas,
  parseArgv,
  holdSec,
  machineReport,
  maxSustainableFleet,
  minSustainableTxIntervalSec,
  parseExposition,
  radicalInverseBase2,
  recommendedWarmupSec,
  redactOptions,
  redactUrlUserinfo,
  requiredRpcPerSec,
  RPC_DEADLINE_MS,
  row,
  sleep,
  socketPoolSize,
  stopTransactionsSent,
  staggerOffsetsMs,
  START_CONFIRM_MARGIN_SEC,
  START_CONFIRM_TIMEOUT_MS,
  sustainableRpcPerSec,
  unpredictedCreatedIds,
  validateOptions,
  type Sample,
  type StepResult,
} from "./lib.ts";

const BASE_ARGS = [
  "--csms-url",
  "ws://localhost:8887/ocpp",
  "--daemon-url",
  "http://127.0.0.1:9700",
];

function argMap(extra: readonly string[] = []) {
  return parseArgv([...BASE_ARGS, ...extra]);
}

describe("parseArgv", () => {
  it("parses --flag value pairs", () => {
    const m = parseArgv(["--duration", "60", "--tx-interval", "1"]);
    expect(m.get("duration")?.value).toBe("60");
    expect(m.get("tx-interval")?.value).toBe("1");
  });

  it("rejects a flag missing its value", () => {
    expect(() => parseArgv(["--duration"])).toThrow(BenchValidationError);
  });

  it("rejects a bare positional argument", () => {
    expect(() => parseArgv(["bar"])).toThrow(BenchValidationError);
  });

  it("rejects an unknown flag instead of silently ignoring it", () => {
    // `--duraton 5` used to parse into the map, never be read, and let the
    // run proceed on the default duration — a typo that silently produced a
    // benchmark measuring something other than what was asked for.
    expect(() => parseArgv(["--duraton", "5"])).toThrow(/unknown flag/);
  });

  it("takes a boolean flag without swallowing the next argument", () => {
    const m = parseArgv(["--allow-existing", "--duration", "60"]);
    expect(m.has("allow-existing")).toBe(true);
    expect(m.get("duration")?.value).toBe("60");
  });

  it("takes a boolean flag as the last argument", () => {
    expect(parseArgv(["--allow-existing"]).has("allow-existing")).toBe(true);
  });
});

describe("validateOptions — happy path and defaults", () => {
  it("accepts the minimal required flags and fills in defaults", () => {
    const opts = validateOptions(argMap());
    expect(opts.csmsUrl).toBe("ws://localhost:8887/ocpp");
    expect(opts.daemonUrl).toBe("http://127.0.0.1:9700");
    expect(opts.counts).toEqual([10, 50, 100, 200]);
    expect(opts.durationSec).toBe(60);
    expect(opts.heartbeatIntervalSec).toBe(5);
    expect(opts.txIntervalSec).toBe(0);
    expect(opts.ocppVersion).toBe("OCPP-1.6J");
    expect(opts.warmupSec).toBe(CALL_WATCHDOG_SEC);
    expect(opts.daemonBasicAuth).toBeNull();
  });

  it("strips a trailing slash from --daemon-url", () => {
    const raw = parseArgv([
      "--csms-url",
      "ws://localhost:8887/ocpp",
      "--daemon-url",
      "http://127.0.0.1:9700/",
    ]);
    expect(validateOptions(raw).daemonUrl).toBe("http://127.0.0.1:9700");
  });

  it("accepts paired basic-auth flags", () => {
    const opts = validateOptions(
      argMap([
        "--daemon-basic-auth-user",
        "u",
        "--daemon-basic-auth-pass",
        "p",
      ]),
    );
    expect(opts.daemonBasicAuth).toEqual({ username: "u", password: "p" });
  });
});

describe("validateOptions — bounds and guards", () => {
  it("requires --csms-url and --daemon-url", () => {
    expect(() => validateOptions(parseArgv([]))).toThrow(BenchValidationError);
  });

  it("rejects a csms-url with an unsupported scheme", () => {
    expect(() =>
      validateOptions(
        parseArgv([
          "--csms-url",
          "ftp://x",
          "--daemon-url",
          "http://127.0.0.1:9700",
        ]),
      ),
    ).toThrow(/--csms-url/);
  });

  it("rejects an http(s) --csms-url rather than silently running OCPP-J", () => {
    // An http(s) URL used to produce a WebSocket fleet against an HTTP
    // endpoint while the flag documentation promised SOAP — and SOAP has no
    // CALL duration histogram to report either way, which is why
    // `--ocpp-version` refuses the SOAP versions for the same reason.
    for (const url of ["http://localhost:8080/ocpp", "https://csms/ocpp"]) {
      expect(() =>
        validateOptions(
          parseArgv([
            "--csms-url",
            url,
            "--daemon-url",
            "http://127.0.0.1:9700",
          ]),
        ),
      ).toThrow(/--csms-url must use ws or wss/);
    }
  });

  it("rejects a daemon-url with a ws scheme", () => {
    expect(() =>
      validateOptions(
        parseArgv([
          "--csms-url",
          "ws://x",
          "--daemon-url",
          "ws://127.0.0.1:9700",
        ]),
      ),
    ).toThrow(BenchValidationError);
  });

  it("rejects a daemon-url longer than MAX_URL_LENGTH", () => {
    const long = "http://" + "a".repeat(2050) + ".test";
    expect(() =>
      validateOptions(
        parseArgv(["--csms-url", "ws://x", "--daemon-url", long]),
      ),
    ).toThrow(BenchValidationError);
  });

  it("rejects non-ascending --counts", () => {
    expect(() => validateOptions(argMap(["--counts", "10,5,20"]))).toThrow(
      /ascending/,
    );
  });

  it("rejects duplicate values in --counts", () => {
    expect(() => validateOptions(argMap(["--counts", "10,10,20"]))).toThrow(
      /ascending/,
    );
  });

  it("rejects a --counts entry above MAX_FLEET_SIZE", () => {
    expect(() =>
      validateOptions(argMap(["--counts", `10,${MAX_FLEET_SIZE + 1}`])),
    ).toThrow(BenchValidationError);
  });

  it("rejects more than MAX_SWEEP_POINTS entries in --counts", () => {
    const many = Array.from(
      { length: MAX_SWEEP_POINTS + 1 },
      (_, i) => i + 1,
    ).join(",");
    expect(() => validateOptions(argMap(["--counts", many]))).toThrow(
      BenchValidationError,
    );
  });

  it("rejects --duration below the minimum", () => {
    expect(() => validateOptions(argMap(["--duration", "1"]))).toThrow(
      BenchValidationError,
    );
  });

  it("rejects --heartbeat-interval of 0", () => {
    expect(() =>
      validateOptions(argMap(["--heartbeat-interval", "0"])),
    ).toThrow(BenchValidationError);
  });

  it("rejects a negative --tx-interval", () => {
    expect(() => validateOptions(argMap(["--tx-interval", "-1"]))).toThrow(
      BenchValidationError,
    );
  });

  it("rejects --duration shorter than 2x --heartbeat-interval", () => {
    expect(() =>
      validateOptions(argMap(["--duration", "5", "--heartbeat-interval", "5"])),
    ).toThrow(/twice/);
  });

  it("accepts --duration exactly 2x --heartbeat-interval", () => {
    expect(() =>
      validateOptions(
        argMap(["--duration", "10", "--heartbeat-interval", "5"]),
      ),
    ).not.toThrow();
  });

  it("rejects a --health-path without a leading slash", () => {
    expect(() => validateOptions(argMap(["--health-path", "healthz"]))).toThrow(
      BenchValidationError,
    );
  });

  it("rejects a lone --daemon-basic-auth-user without the password", () => {
    expect(() =>
      validateOptions(argMap(["--daemon-basic-auth-user", "u"])),
    ).toThrow(BenchValidationError);
  });
});

describe("--ocpp-version", () => {
  it("defaults to OCPP-1.6J and is carried into the options block", () => {
    // Not cosmetic: `cp.create_many` defaults to 1.6J on its own, so this is
    // the value `growFleet` has to send for a 2.x CSMS to see 2.x stations.
    expect(validateOptions(argMap()).ocppVersion).toBe("OCPP-1.6J");
  });

  it("accepts every OCPP-J version the simulator supports", () => {
    for (const version of ["OCPP-1.6J", "OCPP-2.0.1", "OCPP-2.1"] as const) {
      expect(
        validateOptions(argMap(["--ocpp-version", version])).ocppVersion,
      ).toBe(version);
    }
    expect([...BENCH_OCPP_VERSIONS].sort()).toEqual([
      "OCPP-1.6J",
      "OCPP-2.0.1",
      "OCPP-2.1",
    ]);
  });

  it("rejects the SOAP versions, which have no CALL duration histogram", () => {
    // A SOAP log line carries no message id to correlate a response back
    // with, so `ocppcp_ocpp_call_duration_seconds` stays empty and the run
    // would print a latency table of dashes and call it a measurement.
    for (const version of ["OCPP-1.2", "OCPP-1.5", "OCPP-1.6S"]) {
      expect(() =>
        validateOptions(argMap(["--ocpp-version", version])),
      ).toThrow(/--ocpp-version must be one of/);
    }
  });

  it("rejects a version the simulator does not know at all", () => {
    expect(() =>
      validateOptions(argMap(["--ocpp-version", "OCPP-3.0"])),
    ).toThrow(BenchValidationError);
    // A near-miss spelling is a typo, not a request for the default.
    expect(() =>
      validateOptions(argMap(["--ocpp-version", "ocpp-2.0.1"])),
    ).toThrow(BenchValidationError);
  });
});

describe("--warmup", () => {
  it("adds the ramp only when there is a cycle to ramp up", () => {
    // `holdSec` floors at 1s, so `cyclePeriodSec(0)` is 2 — but the idle axis
    // starts no transactions at all and has nothing to ramp. Asking for the
    // period unconditionally invented a 2s ramp for a fleet that never uses
    // one.
    expect(recommendedWarmupSec(0)).toBe(CALL_WATCHDOG_SEC);
    // `--tx-interval 1` really cycles every 2s, so its ramp is 2s, not 1s.
    expect(recommendedWarmupSec(1)).toBe(CALL_WATCHDOG_SEC + 2);
    expect(recommendedWarmupSec(15)).toBe(CALL_WATCHDOG_SEC + 15);
  });

  it("defaults to one CALL watchdog on the idle axis", () => {
    expect(validateOptions(argMap()).warmupSec).toBe(CALL_WATCHDOG_SEC);
  });

  it("defaults to the stagger ramp plus one watchdog on the active axis", () => {
    // The active axis spreads first transactions across one --tx-interval, so
    // a fixed 30s warmup would open the window while part of the fleet had
    // still not issued its first StartTransaction.
    const opts = validateOptions(argMap(["--tx-interval", "45"]));
    expect(opts.warmupSec).toBe(CALL_WATCHDOG_SEC + 45);
    expect(recommendedWarmupSec(45)).toBe(CALL_WATCHDOG_SEC + 45);
  });

  it("caps the computed default at MAX_WARMUP_SEC", () => {
    expect(recommendedWarmupSec(3600)).toBe(MAX_WARMUP_SEC);
    expect(
      validateOptions(argMap(["--tx-interval", "3600"])).warmupSec,
    ).toBeLessThanOrEqual(MAX_WARMUP_SEC);
  });

  it("accepts an explicit value, including 0", () => {
    expect(validateOptions(argMap(["--warmup", "90"])).warmupSec).toBe(90);
    // 0 is a deliberate opt-out for a smoke run; the script prints a note
    // rather than refusing, since the cost is attribution, not correctness
    // of the latency columns.
    expect(validateOptions(argMap(["--warmup", "0"])).warmupSec).toBe(0);
  });

  it("rejects a negative --warmup and one past MAX_WARMUP_SEC", () => {
    expect(() => validateOptions(argMap(["--warmup", "-1"]))).toThrow(
      /--warmup must be between 0 and/,
    );
    expect(() =>
      validateOptions(argMap(["--warmup", String(MAX_WARMUP_SEC + 1)])),
    ).toThrow(/--warmup must be between 0 and/);
  });
});

describe("staggerOffsetsMs", () => {
  const PERIOD_MS = 60_000;

  /** The widest silent stretch in the cycle, as a fraction of one period —
   *  the thing a stagger exists to keep small, and what a burst blows up. */
  function maxGapFraction(offsetsMs: readonly number[]): number {
    const sorted = [...offsetsMs].sort((a, b) => a - b);
    let widest = 0;
    for (let i = 0; i < sorted.length; i++) {
      const next = sorted[(i + 1) % sorted.length]!;
      const gap =
        i === sorted.length - 1
          ? next + PERIOD_MS - sorted[i]!
          : next - sorted[i]!;
      widest = Math.max(widest, gap);
    }
    return widest / PERIOD_MS;
  }

  it("spreads one cohort across the cycle period", () => {
    expect(staggerOffsetsMs(0, 4, 60)).toEqual([0, 30_000, 15_000, 45_000]);
    // Never reaches the full period: an offset of one period would collide
    // with the first CP's next cycle rather than sit between the others.
    expect(staggerOffsetsMs(0, 4, 60).every((ms) => ms < PERIOD_MS)).toBe(true);
  });

  it("spans the cycle period, not the raw --tx-interval", () => {
    // A hold is floored at 1s, so `--tx-interval 1` really cycles every 2s.
    // Spreading over 1s would bunch the whole fleet into half the phase space.
    expect(staggerOffsetsMs(0, 2, 1)).toEqual([0, 1_000]);
    expect(cyclePeriodSec(1)).toBe(2);
  });

  it("keeps later cohorts out of the phases earlier ones already hold", () => {
    // The finding: `armLoad` gets only the step's *new* charge points, so a
    // per-cohort stagger restarted at phase 0 every step. With --counts 1,2,3
    // and step durations that are multiples of the period, all three singleton
    // cohorts landed in nearly the same phase — a burst, and a knee belonging
    // to this script rather than to the daemon.
    const first = staggerOffsetsMs(0, 1, 60);
    const second = staggerOffsetsMs(1, 1, 60);
    const third = staggerOffsetsMs(2, 1, 60);
    expect(new Set([...first, ...second, ...third]).size).toBe(3);
    // And they are genuinely spread, not merely distinct.
    expect(maxGapFraction([...first, ...second, ...third])).toBeLessThanOrEqual(
      2 / 3,
    );
  });

  it("stays well spread at every fleet size a growing sweep passes through", () => {
    // The property that makes fixed global phases work at all: *every prefix*
    // of the sequence is near-uniform, so the fleet is spread at each step of
    // the sweep without ever re-phasing a charge point that is already
    // cycling. A perfect ring would be 1/n; a burst would be ~1.
    //
    // Swept over the **whole accepted range**, not a sample of it: the docs
    // promise `2/n` in three places, and `--counts` reaches MAX_FLEET_SIZE.
    // The worst case sits at n = 2^k + 1, where the true bound
    // `1/2^floor(log2 n)` is at its closest to `2/n`, so a loop that stopped
    // early would leave the promise untested exactly where it is tightest.
    for (let n = 1; n <= MAX_FLEET_SIZE; n++) {
      expect(maxGapFraction(staggerOffsetsMs(0, n, 60))).toBeLessThanOrEqual(
        2 / n,
      );
    }
    // And the tightest points specifically, named so a regression says why.
    // From k = 1: `floor(log2 n)` is k only once n = 2^k + 1 exceeds 2, and at
    // n = 2 the two phases are 0 and ½, a gap of ½ rather than 1.
    for (let k = 1; k <= 10; k++) {
      const n = 2 ** k + 1;
      expect(maxGapFraction(staggerOffsetsMs(0, n, 60))).toBeCloseTo(
        1 / 2 ** k,
        10,
      );
    }
  });

  it("gives a grown fleet the same phases as one created all at once", () => {
    // Grow-in-place must not change the answer: cohorts of 10, then 40, then
    // 50 must leave the fleet in exactly the arrangement 100 at once would.
    const grown = [
      ...staggerOffsetsMs(0, 10, 60),
      ...staggerOffsetsMs(10, 40, 60),
      ...staggerOffsetsMs(50, 50, 60),
    ];
    expect(grown).toEqual(staggerOffsetsMs(0, 100, 60));
    expect(new Set(grown).size).toBe(100);
  });

  it("is deterministic, so two identical runs issue the same pattern", () => {
    // The project's contract is that every random behaviour is seeded and
    // replayable (docs/analyses/fleet-load-and-observability-roadmap.md).
    // `Math.random()` here made the phase distribution — and so the observed
    // knee — differ between two runs with identical flags.
    const a = staggerOffsetsMs(0, 50, 30);
    const b = staggerOffsetsMs(0, 50, 30);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(50);
  });

  it("returns nothing for an empty step and zeros for the idle axis", () => {
    expect(staggerOffsetsMs(0, 0, 30)).toEqual([]);
    expect(staggerOffsetsMs(0, 3, 0)).toEqual([0, 0, 0]);
  });

  it("generates the van der Corput sequence it documents", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(radicalInverseBase2)).toEqual([
      0, 0.5, 0.25, 0.75, 0.125, 0.625, 0.375, 0.875,
    ]);
  });
});

describe("waiting for a transaction to start (#302)", () => {
  it("waits for authorization, never merely for a hold", () => {
    // The finding: `--tx-interval 2` gives a 1s hold while `authorizeAndWait`
    // may legitimately take 10s, so a hold-length wait declared the start dead
    // while it was still pending — the stop then hit a transaction that did
    // not exist and the next cycle began into the arrival of the old one.
    expect(START_CONFIRM_TIMEOUT_MS).toBeGreaterThan(AUTHORIZE_WAIT_SEC * 1000);
    for (const tx of [1, 2, 3, 5, 10]) {
      expect(START_CONFIRM_TIMEOUT_MS).toBeGreaterThan(holdSec(tx) * 1000);
    }
  });

  it("waits long enough for the answer to be definitive", () => {
    // `authorizeAndWait` never rejects: on timeout it warns and resolves
    // "Accepted". So past its bound the start was genuinely denied, and a
    // cycle that waited this long waited for an answer rather than giving up.
    expect(START_CONFIRM_TIMEOUT_MS).toBe(
      (AUTHORIZE_WAIT_SEC + START_CONFIRM_MARGIN_SEC) * 1000,
    );
    expect(START_CONFIRM_MARGIN_SEC).toBeGreaterThan(0);
  });
});

describe("parseExposition", () => {
  it("parses gauges, counters and skips HELP/TYPE/blank lines", () => {
    const text = [
      "# HELP ocppcp_charge_points x",
      "# TYPE ocppcp_charge_points gauge",
      'ocppcp_charge_points{state="Available"} 3',
      "",
      "ocppcp_ws_reconnects_total 7",
    ].join("\n");
    const samples = parseExposition(text);
    expect(samples).toEqual([
      {
        name: "ocppcp_charge_points",
        labels: { state: "Available" },
        value: 3,
      },
      { name: "ocppcp_ws_reconnects_total", labels: {}, value: 7 },
    ]);
  });

  it("unescapes label values the way render.ts escapes them", () => {
    const text = 'x{a="a \\"quoted\\" \\\\ line\\nbreak"} 1';
    const samples = parseExposition(text);
    expect(samples[0]!.labels.a).toBe('a "quoted" \\ line\nbreak');
  });

  it("ignores a line that fails to parse rather than throwing", () => {
    expect(() => parseExposition("not a metric line at all")).not.toThrow();
    expect(parseExposition("not a metric line at all")).toEqual([]);
  });
});

function histSample(
  name: string,
  action: string,
  le: string,
  value: number,
): Sample {
  return { name, labels: { action, le }, value };
}

function bucketSet(
  action: string,
  cumulative: readonly number[],
  edges: readonly number[],
): Sample[] {
  const out = edges.map((le, i) =>
    histSample(
      "ocppcp_ocpp_call_duration_seconds_bucket",
      action,
      String(le),
      cumulative[i]!,
    ),
  );
  const total = cumulative[cumulative.length - 1]!;
  out.push(
    histSample(
      "ocppcp_ocpp_call_duration_seconds_bucket",
      action,
      "+Inf",
      total,
    ),
  );
  out.push({
    name: "ocppcp_ocpp_call_duration_seconds_sum",
    labels: { action },
    value: total * 0.1, // arbitrary, not exercised precisely here
  });
  out.push({
    name: "ocppcp_ocpp_call_duration_seconds_count",
    labels: { action },
    value: total,
  });
  return out;
}

describe("diffHistogram / mergeHistogramDeltas / histogramQuantile", () => {
  const edges = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

  it("computes a per-action delta between two cumulative scrapes", () => {
    const before = bucketSet(
      "Heartbeat",
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      edges,
    );
    // after: 10 samples total, 5 at/under 0.05s, 10 at/under 0.1s.
    const after = bucketSet(
      "Heartbeat",
      [0, 0, 5, 10, 10, 10, 10, 10, 10, 10, 10],
      edges,
    );
    const deltas = diffHistogram(
      before,
      after,
      "ocppcp_ocpp_call_duration_seconds",
    );
    const hb = deltas.get("Heartbeat")!;
    expect(hb.count).toBe(10);
    expect(hb.buckets.find((b) => b.le === 0.05)?.count).toBe(5);
    expect(hb.buckets.find((b) => b.le === 0.1)?.count).toBe(10);
  });

  it("treats an action absent from the baseline as starting at 0", () => {
    const before: Sample[] = [];
    const after = bucketSet(
      "StartTransaction",
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      edges,
    );
    const deltas = diffHistogram(
      before,
      after,
      "ocppcp_ocpp_call_duration_seconds",
    );
    expect(deltas.get("StartTransaction")?.count).toBe(1);
  });

  it("clamps a negative delta (counter reset) to zero instead of going negative", () => {
    const before = bucketSet(
      "Heartbeat",
      [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5],
      edges,
    );
    const after = bucketSet(
      "Heartbeat",
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      edges,
    );
    const deltas = diffHistogram(
      before,
      after,
      "ocppcp_ocpp_call_duration_seconds",
    );
    expect(deltas.get("Heartbeat")?.count).toBe(0);
  });

  it("merges two actions' deltas into one series by summing per-bucket counts", () => {
    const before: Sample[] = [];
    const after = [
      ...bucketSet(
        "Heartbeat",
        [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10],
        edges,
      ),
      ...bucketSet(
        "StartTransaction",
        [0, 0, 0, 0, 0, 10, 10, 10, 10, 10, 10],
        edges,
      ),
    ];
    const deltas = diffHistogram(
      before,
      after,
      "ocppcp_ocpp_call_duration_seconds",
    );
    const merged = mergeHistogramDeltas(deltas);
    expect(merged.count).toBe(20);
    expect(merged.buckets.find((b) => b.le === 0.01)?.count).toBe(10);
    expect(merged.buckets.find((b) => b.le === 0.5)?.count).toBe(20);
  });

  it("interpolates p50 linearly within the bucket the target falls in", () => {
    // 100 samples uniform up to bucket le=0.1 (cumulative 100 there), 0
    // below 0.05. p50 target = 50, which is exactly at 0.1 given the jump
    // from 0 (at 0.05) to 100 (at 0.1): interpolate between (0.05, 0) and
    // (0.1, 100) -> 0.05 + 0.5*(0.1-0.05) = 0.075.
    const before: Sample[] = [];
    const after = bucketSet(
      "Heartbeat",
      [0, 0, 0, 100, 100, 100, 100, 100, 100, 100, 100],
      edges,
    );
    const deltas = diffHistogram(
      before,
      after,
      "ocppcp_ocpp_call_duration_seconds",
    );
    const q = histogramQuantile(deltas.get("Heartbeat")!, 0.5);
    expect(q.kind).toBe("value");
    expect((q as { seconds: number }).seconds).toBeCloseTo(0.075, 10);
  });

  it("reports overflow when the quantile falls past the last finite bucket", () => {
    // All 10 samples land past the last finite edge (30s) — impossible in
    // practice for this histogram (the +Inf bucket count would then exceed
    // every finite bucket), constructed here purely to exercise the
    // overflow branch.
    const before: Sample[] = [];
    const zeros = edges.map(() => 0);
    const bucketsBefore = bucketSet("Heartbeat", zeros, edges);
    // Manually raise +Inf above every finite bucket.
    const after = bucketsBefore.map((s) =>
      s.labels.le === "+Inf" ? { ...s, value: 10 } : s,
    );
    const deltas = diffHistogram(
      before,
      after,
      "ocppcp_ocpp_call_duration_seconds",
    );
    const q = histogramQuantile(deltas.get("Heartbeat")!, 0.99);
    expect(q.kind).toBe("overflow");
  });

  it("reports no-data for a series with zero samples", () => {
    const before: Sample[] = [];
    const after = bucketSet(
      "Heartbeat",
      edges.map(() => 0),
      edges,
    );
    const deltas = diffHistogram(
      before,
      after,
      "ocppcp_ocpp_call_duration_seconds",
    );
    expect(histogramQuantile(deltas.get("Heartbeat")!, 0.5)).toEqual({
      kind: "no-data",
    });
  });
});

describe("formatSeconds", () => {
  it("renders sub-second values in ms and larger ones in s", () => {
    expect(formatSeconds({ kind: "value", seconds: 0.075 })).toBe("75ms");
    expect(formatSeconds({ kind: "value", seconds: 1.5 })).toBe("1.50s");
    expect(formatSeconds({ kind: "overflow", lastEdge: 30 })).toBe(">30s");
    expect(formatSeconds({ kind: "no-data" })).toBe("-");
  });
});

describe("formatTable", () => {
  it("aligns columns to the widest cell", () => {
    const out = formatTable(
      ["N", "p50"],
      [
        ["10", "5ms"],
        ["200", "120ms"],
      ],
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("N    p50");
    expect(lines[1]).toBe("---  -----");
    expect(lines[3]).toBe("200  120ms");
  });
});

describe("TokenBucket", () => {
  it("throttles once the initial allotment is spent", async () => {
    const bucket = new TokenBucket(1000); // 1000/sec, so ~1ms per token
    const start = Date.now();
    for (let i = 0; i < 1000; i++) await bucket.take();
    // one second's worth of tokens should not need to wait
    expect(Date.now() - start).toBeLessThan(500);
    // the 1001st token must wait for a refill
    await bucket.take();
    expect(Date.now() - start).toBeGreaterThanOrEqual(0);
  });
});

describe("Semaphore", () => {
  it("bounds concurrency to the configured count", async () => {
    const sem = new Semaphore(2);
    let concurrent = 0;
    let maxConcurrent = 0;
    async function work() {
      const release = await sem.acquire();
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent--;
      release();
    }
    await Promise.all([work(), work(), work(), work(), work()]);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });
});

describe("--allow-existing", () => {
  it("defaults to false", () => {
    expect(validateOptions(argMap()).allowExisting).toBe(false);
  });

  it("is set by the flag", () => {
    expect(validateOptions(argMap(["--allow-existing"])).allowExisting).toBe(
      true,
    );
  });
});

describe("redaction of a --out result file", () => {
  it("replaces the daemon basic-auth password and keeps the username", () => {
    // A result file is meant to be kept and shared; serialising the options
    // verbatim wrote the daemon's Basic Auth password into it in plaintext.
    const opts = validateOptions(
      argMap([
        "--daemon-basic-auth-user",
        "ops",
        "--daemon-basic-auth-pass",
        "hunter2",
      ]),
    );
    const redacted = redactOptions(opts);
    expect(JSON.stringify(redacted)).not.toContain("hunter2");
    expect(redacted.daemonBasicAuth).toEqual({
      username: "ops",
      password: "***",
    });
  });

  it("leaves a null basic-auth block null", () => {
    expect(redactOptions(validateOptions(argMap())).daemonBasicAuth).toBeNull();
  });

  it("strips userinfo embedded in a URL", () => {
    expect(redactUrlUserinfo("wss://user:pass@csms.example/ocpp")).toBe(
      "wss://user:***@csms.example/ocpp",
    );
    expect(redactUrlUserinfo("https://admin:s3cr3t@127.0.0.1:9700")).toBe(
      "https://admin:***@127.0.0.1:9700",
    );
  });

  it("redacts a password containing an @, to the last delimiter", () => {
    // WHATWG URL parsing takes the LAST @ before the path as the userinfo
    // delimiter, so `p@ss` is a legal password. Stopping at the first @ would
    // have published its tail.
    expect(redactUrlUserinfo("wss://user:p@ss@host/ocpp")).toBe(
      "wss://user:***@host/ocpp",
    );
    expect(redactUrlUserinfo("https://ops:a@b@c@127.0.0.1:9700")).toBe(
      "https://ops:***@127.0.0.1:9700",
    );
  });

  it("leaves a URL with no password untouched", () => {
    expect(redactUrlUserinfo("wss://user@csms.example/ocpp")).toBe(
      "wss://user@csms.example/ocpp",
    );
    expect(redactUrlUserinfo("ws://localhost:8887/ocpp")).toBe(
      "ws://localhost:8887/ocpp",
    );
  });

  it("does not mistake a path or query for userinfo", () => {
    expect(redactUrlUserinfo("http://127.0.0.1:9700/a@b?c=d@e")).toBe(
      "http://127.0.0.1:9700/a@b?c=d@e",
    );
  });

  it("redacts both URLs in the options block", () => {
    const opts = validateOptions(
      parseArgv([
        "--csms-url",
        "wss://cp:tok@csms.example/ocpp",
        "--daemon-url",
        "https://ops:pw@127.0.0.1:9700",
      ]),
    );
    const redacted = redactOptions(opts);
    expect(redacted.csmsUrl).toBe("wss://cp:***@csms.example/ocpp");
    expect(redacted.daemonUrl).toBe("https://ops:***@127.0.0.1:9700");
    expect(JSON.stringify(redacted)).not.toContain("tok");
  });
});

describe("fleetGauge", () => {
  const scrape = (text: string): Sample[] => parseExposition(text);

  it("sums the gauge and excludes Unavailable from the connected count", () => {
    const samples = scrape(
      [
        "# TYPE ocppcp_charge_points gauge",
        'ocppcp_charge_points{state="Available"} 7',
        'ocppcp_charge_points{state="Charging"} 2',
        'ocppcp_charge_points{state="Unavailable"} 3',
        "ocppcp_transactions_active 2",
      ].join("\n"),
    );
    expect(fleetGauge(samples)).toEqual({ total: 12, connected: 9 });
  });

  it("reports zeroes for an empty daemon", () => {
    expect(fleetGauge(scrape("ocppcp_transactions_active 0"))).toEqual({
      total: 0,
      connected: 0,
    });
  });
});

describe("assertDaemonEmpty", () => {
  const withCps = (n: number): Sample[] =>
    parseExposition(`ocppcp_charge_points{state="Available"} ${n}`);

  it("refuses a daemon that already holds charge points", () => {
    // /metrics has no cpId label by design, so pre-existing charge points'
    // traffic lands in the same histogram as the bench fleet's while the
    // reported N counts only the bench's own.
    expect(() => assertDaemonEmpty(withCps(4), false)).toThrow(
      /already holds 4 charge point/,
    );
  });

  it("returns 0 for an empty daemon", () => {
    expect(assertDaemonEmpty(withCps(0), false)).toBe(0);
    expect(assertDaemonEmpty(parseExposition(""), false)).toBe(0);
  });

  it("returns the pre-existing count when --allow-existing waives the refusal", () => {
    expect(assertDaemonEmpty(withCps(4), true)).toBe(4);
  });
});

describe("the socket pool's sustainable load ceiling (#302)", () => {
  it("derives the required rate from the real cycle period, not the raw flag", () => {
    // `holdMs` is floored at 1s, so --tx-interval 1 really cycles every 2s.
    // Computing the requirement from the flag would have overstated it by 2x
    // there and rejected runs the pool can actually drive.
    expect(holdSec(1)).toBe(1);
    expect(cyclePeriodSec(1)).toBe(2);
    expect(cyclePeriodSec(4)).toBe(4);
    // Two RPCs (start + stop) per charge point per cycle.
    expect(requiredRpcPerSec(1000, 4)).toBe(500);
    expect(requiredRpcPerSec(1000, 1)).toBe(1000);
    // The idle axis issues nothing after arming.
    expect(requiredRpcPerSec(2000, 0)).toBe(0);
  });

  it("sizes the pool by the transaction rate, not only by the fleet", () => {
    // 200 CPs fit on one socket by count, but at --tx-interval 2 they need
    // 200 RPC/s and one socket allows 64 — the throttle that made the bench
    // apply a third of the configured load and report its latency as the
    // configured load's.
    expect(socketPoolSize(200, 0)).toBe(1);
    expect(socketPoolSize(200, 2)).toBe(
      Math.ceil(200 / (RPC_RATE_PER_SOCKET * RPC_HEADROOM)),
    );
    expect(socketPoolSize(200, 2)).toBeGreaterThan(1);
    // Never past the cap; validateOptions is what refuses those runs.
    expect(socketPoolSize(MAX_FLEET_SIZE, 2)).toBe(MAX_SOCKETS);
  });

  it("refuses a sweep the pool cannot sustain, with the numbers", () => {
    // The finding verbatim: N=2000 at --tx-interval 2 needs ~2000 RPC/s and
    // ten sockets allow 640.
    expect(() =>
      validateOptions(argMap(["--counts", "2000", "--tx-interval", "2"])),
    ).toThrow(BenchValidationError);
    let message = "";
    try {
      validateOptions(argMap(["--counts", "2000", "--tx-interval", "2"]));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("2000 control-plane RPC/s");
    expect(message).toContain(
      `${sustainableRpcPerSec(MAX_SOCKETS).toFixed(0)} RPC/s`,
    );
    expect(message).toContain(
      `--tx-interval to ${minSustainableTxIntervalSec(2000)}`,
    );
    expect(message).toContain(`--counts at ${maxSustainableFleet(2)}`);
  });

  it("accepts the same fleet once --tx-interval clears the ceiling", () => {
    const tx = minSustainableTxIntervalSec(2000);
    const opts = validateOptions(
      argMap(["--counts", "2000", "--tx-interval", String(tx)]),
    );
    expect(opts.counts.at(-1)).toBe(2000);
    expect(requiredRpcPerSec(2000, tx)).toBeLessThanOrEqual(
      sustainableRpcPerSec(MAX_SOCKETS),
    );
    // And one below it does not.
    expect(() =>
      validateOptions(
        argMap(["--counts", "2000", "--tx-interval", String(tx - 1)]),
      ),
    ).toThrow(BenchValidationError);
  });

  it("never rejects the idle axis, whatever the fleet size", () => {
    // Heartbeats are daemon-side timers; the bench issues no recurring RPC.
    expect(
      validateOptions(argMap(["--counts", String(MAX_FLEET_SIZE)])).counts.at(
        -1,
      ),
    ).toBe(MAX_FLEET_SIZE);
  });

  it("states a ceiling the two helpers agree on", () => {
    for (const tx of [2, 3, 5, 10, 60]) {
      const n = maxSustainableFleet(tx);
      expect(requiredRpcPerSec(n, tx)).toBeLessThanOrEqual(
        sustainableRpcPerSec(MAX_SOCKETS),
      );
      expect(requiredRpcPerSec(n + 1, tx)).toBeGreaterThan(
        sustainableRpcPerSec(MAX_SOCKETS),
      );
    }
  });
});

describe("predicted charge point ids (#302)", () => {
  it("expands the pattern the daemon is asked for", () => {
    // The ids a batch offers must be nameable before its RPC answers: a
    // create that times out after the daemon created the charge points leaves
    // them registered, and the next run's preflight refuses that daemon.
    const runId = "abc-1234";
    expect(benchIdPattern(runId)).toBe("BENCH-abc-1234-{n:06}");
    expect(benchCpId(runId, 1)).toBe("BENCH-abc-1234-000001");
    expect(benchCpId(runId, 42)).toBe("BENCH-abc-1234-000042");
    expect(benchCpId(runId, 1000)).toBe("BENCH-abc-1234-001000");
    expect(benchCpId(runId, 999_999)).toBe("BENCH-abc-1234-999999");
    // Past the pad width the index simply grows, exactly as padStart does in
    // `expandIdPattern`.
    expect(benchCpId(runId, 1_000_000)).toBe("BENCH-abc-1234-1000000");
  });

  it("gives every run its own id space, so a collision cannot arise", () => {
    // The primary fix for "the benchmark deletes charge points it did not
    // create": it is not that we reason about the ack correctly, it is that a
    // pre-existing charge point cannot be sitting on an id this run offers.
    const a = newRunId(1_700_000_000_000);
    const b = newRunId(1_700_000_000_000);
    expect(a).not.toBe(b);
    expect(benchCpId(a, 1)).not.toBe(benchCpId(b, 1));
    // The shared root is what still recognises an older run's leftovers.
    expect(benchCpId(a, 1).startsWith(`${BENCH_ID_ROOT}-`)).toBe(true);
    // A run id never contains the `{n}` placeholder or anything that would
    // change how the daemon expands the pattern.
    expect(a).toMatch(/^[0-9a-z]+-[0-9a-z]{4}$/);
  });

  it("sorts run ids in run order and stays inside the daemon's id cap", () => {
    const early = newRunId(1_700_000_000_000, () => 0);
    const later = newRunId(1_700_000_001_000, () => 0);
    expect(later > early).toBe(true);
    // MAX_GENERATED_CP_ID_LENGTH is 256 in src/protocol/methods.ts.
    expect(benchCpId(newRunId(Date.now()), 999_999).length).toBeLessThan(64);
  });
});

describe("a step's reported row (#302)", () => {
  const emptyAggregate = mergeHistogramDeltas(new Map());

  function step(over: Partial<StepResult> = {}): StepResult {
    return {
      requested: 10,
      fleet: 10,
      connectedAtSettle: 10,
      connectedAtEnd: 10,
      notSettled: 0,
      aggregate: emptyAggregate,
      heartbeat: null,
      timeouts: 0,
      evictions: 0,
      errors: 0,
      reconnects: 0,
      unconfirmedStarts: 0,
      lateHolds: 0,
      retired: 0,
      ...over,
    };
  }

  const col = (r: StepResult, name: (typeof STEP_COLUMNS)[number]): string =>
    row(r)[STEP_COLUMNS.indexOf(name)]!;

  it("has one cell per column", () => {
    expect(row(step())).toHaveLength(STEP_COLUMNS.length);
  });

  it("labels a partial fleet with the size it actually has", () => {
    // 10 requested, 8 created, 8 connected used to print "N=10, connected=8,
    // unsettled=0" — attributing the latency to a fleet that never existed.
    const r = step({
      requested: 10,
      fleet: 8,
      connectedAtSettle: 8,
      connectedAtEnd: 8,
      notSettled: 0,
    });
    expect(col(r, "N")).toBe("8");
    expect(col(r, "uncreated")).toBe("2");
    expect(col(r, "connected")).toBe("8");
    expect(col(r, "unsettled")).toBe("0");
  });

  it("reports no uncreated charge points when the whole fleet came up", () => {
    expect(col(step(), "uncreated")).toBe("0");
  });

  it("prints n/a, not 0, where the watchdog does not exist", () => {
    // OCPP 2.x has no per-CALL watchdog, so nothing feeds the timeout
    // counter there. A 0 would read as "no calls were abandoned".
    expect(col(step({ timeouts: null }), "timeouts")).toBe("n/a");
    expect(col(step({ timeouts: 3 }), "timeouts")).toBe("3");
  });

  it("keeps late answers out of the timeout column", () => {
    // A duration is only observed when an answer arrives, so a CALL that was
    // never answered contributes nothing to the histogram at all.
    const late = mergeHistogramDeltas(
      new Map([
        [
          "Heartbeat",
          {
            action: "Heartbeat",
            buckets: [
              { le: 1, count: 1 },
              { le: 30, count: 1 },
            ],
            count: 4,
            sum: 100,
          },
        ],
      ]),
    );
    const r = step({ aggregate: late, timeouts: 0 });
    expect(answeredAfterWatchdog(r)).toBe(3);
    expect(col(r, "late>30s")).toBe("3");
    expect(col(r, "timeouts")).toBe("0");
  });

  it("surfaces unconfirmed transaction starts", () => {
    expect(col(step({ unconfirmedStarts: 7 }), "unconf.tx")).toBe("7");
  });
});

describe("transaction-start tracking (#302)", () => {
  it("resolves an armed waiter when its charge point confirms", async () => {
    const starts = new TransactionStarts();
    const armed = starts.arm("CP-A", 5_000, false);
    starts.confirm("CP-A", 0);
    expect(await armed).toMatchObject({ started: true, transactionId: 0 });
  });

  it("resolves unstarted when no confirmation arrives in time", async () => {
    const starts = new TransactionStarts();
    expect(await starts.arm("CP-A", 10, false)).toMatchObject({
      started: false,
      transactionId: null,
    });
  });

  it("waits for the CSMS-assigned id before letting the cycle proceed", async () => {
    // The round-nine finding. Taking only the first emission kept a straggling
    // conf from confirming a newer cycle, but discarded the assigned id — so a
    // conf slower than the hold left `stop_transaction` carrying the
    // placeholder 0, which `sendStopTransaction` snapshots immediately and the
    // CSMS rejects. That happens near the latency knee, which is exactly where
    // the measurement matters.
    const starts = new TransactionStarts();
    const armed = starts.arm("CP-A", 5_000, true);
    starts.confirm("CP-A", 0); // local start; not enough on its own
    let settled = false;
    void armed.then(() => {
      settled = true;
    });
    await sleep(20);
    expect(settled).toBe(false);
    starts.confirm("CP-A", 4242); // StartTransaction.conf
    expect(await armed).toMatchObject({ started: true, transactionId: 4242 });
  });

  it("takes the emissions in order, not by the value they carry", async () => {
    // Phases are explicit now. The first emission after arming is this cycle's
    // local start whatever id it carries, and the second is the assigned id
    // whatever id *it* carries. Nothing tests `transactionId === 0`, because
    // zero is a legal assignment.
    const starts = new TransactionStarts();
    const armed = starts.arm("CP-A", 5_000, true);
    starts.confirm("CP-A", 0);
    let settled = false;
    void armed.then(() => {
      settled = true;
    });
    await sleep(20);
    expect(settled).toBe(false);
    starts.confirm("CP-A", 7);
    expect(await armed).toMatchObject({ started: true, transactionId: 7 });
  });

  it("recognises a CSMS that assigns transaction id zero", async () => {
    // OCPP 1.6's transactionId is schema-valid for any integer. Treating 0 as
    // "still the placeholder" meant such a CSMS was never recognised: the
    // cycle waited its full timeout and retired the charge point despite a
    // valid confirmation.
    const starts = new TransactionStarts();
    const armed = starts.arm("CP-A", 5_000, true);
    starts.confirm("CP-A", 0); // local start
    starts.confirm("CP-A", 0); // and the CSMS really did assign 0
    const outcome = await armed;
    expect(outcome.started).toBe(true);
    // Zero, not null: an assignment happened. The caller retires only on null.
    expect(outcome.transactionId).toBe(0);
    expect(outcome.transactionId).not.toBe(null);
  });

  it("reports a start whose id never arrived, rather than calling it unstarted", async () => {
    // A CSMS that never assigns an id must not hang the cycle, and the caller
    // needs to tell "never started" from "started, no id" — the second still
    // has a transaction to stop. `null` is what says "no id", because 0 is a
    // legal assignment and could not carry that meaning.
    const starts = new TransactionStarts();
    const armed = starts.arm("CP-A", 30, true);
    starts.confirm("CP-A", 0);
    const outcome = await armed;
    expect(outcome.started).toBe(true);
    expect(outcome.transactionId).toBe(null);
    expect(outcome.localStartAtMs).not.toBe(null);
  });

  it("does not wait for an id on a version that never assigns one", async () => {
    // OCPP 2.x never sets the numeric id, so waiting would time out every
    // cycle and stretch the cadence for an id that is not coming.
    const starts = new TransactionStarts();
    const armed = starts.arm("CP-A", 5_000, false);
    starts.confirm("CP-A", 0);
    expect(await armed).toMatchObject({ started: true, transactionId: 0 });
  });

  it("ignores a confirmation for a charge point nobody is waiting on", async () => {
    const starts = new TransactionStarts();
    const armed = starts.arm("CP-A", 5_000, false);
    starts.confirm("CP-A", 0);
    expect((await armed).started).toBe(true);
    starts.confirm("CP-A", 0);
    expect(starts.isAvailable).toBe(true);
  });

  it("stops waiting the moment the stream is lost, instead of burning a hold", async () => {
    // The finding: after a drop, every later arm waited its full hold for a
    // confirmation that could never arrive, then the cycle waited the real
    // hold on top — roughly doubling transaction occupancy and collapsing the
    // rest period, so later rows carried a load the row no longer described.
    const starts = new TransactionStarts();
    starts.lose("socket dropped");
    const startedAt = Date.now();
    expect((await starts.arm("CP-A", 3_000, true)).started).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(starts.isAvailable).toBe(false);
  });

  it("fails the waiters that were already armed when the stream was lost", async () => {
    const starts = new TransactionStarts();
    const armed = starts.arm("CP-A", 5_000, true);
    starts.lose("socket dropped");
    expect((await armed).started).toBe(false);
  });

  it("bounds the assigned-id wait by the point the daemon itself gives up", () => {
    // Same reasoning as START_CONFIRM_TIMEOUT_MS: once StartTransaction has
    // been abandoned by the per-CALL watchdog, its conf will never arrive, so
    // waiting past that buys nothing.
    expect(ASSIGNED_ID_TIMEOUT_MS).toBeGreaterThan(START_CONFIRM_TIMEOUT_MS);
    expect(ASSIGNED_ID_TIMEOUT_MS).toBe(
      (AUTHORIZE_WAIT_SEC + CALL_WATCHDOG_SEC + START_CONFIRM_MARGIN_SEC) *
        1000,
    );
  });

  it("aborts the waits raced against it, naming the reason", async () => {
    const starts = new TransactionStarts();
    const waiting = starts.lost(sleep(5_000));
    starts.lose("socket dropped mid-sweep");
    await expect(waiting).rejects.toThrow(BenchAbortError);
    await expect(waiting).rejects.toThrow(/socket dropped mid-sweep/);
    // And a wait started *after* the loss aborts too, rather than running on.
    await expect(starts.lost(sleep(5_000))).rejects.toThrow(BenchAbortError);
  });

  it("lets a wait through while the stream is healthy", async () => {
    const starts = new TransactionStarts();
    expect(await starts.lost(Promise.resolve("ok"))).toBe("ok");
  });

  it("does not turn a deliberate close into an abort", async () => {
    // The real sequence, not a hypothetical one: `TransactionWatcher.close()`
    // closes the tracker and then disconnects the socket, and that disconnect
    // fires the same handler a genuine drop does. A run that finished must not
    // report a failure it did not have — nor abort whatever the SIGINT path is
    // still awaiting.
    const starts = new TransactionStarts();
    const armed = starts.arm("CP-A", 5_000, false);
    starts.close();
    starts.lose("the socket disconnected because we closed it");
    expect((await armed).started).toBe(false);
    expect(starts.isAvailable).toBe(false);
    const outcome = await Promise.race([
      starts.lost(sleep(30)).then(() => "resolved"),
      sleep(500).then(() => "still-waiting"),
    ]).catch(() => "aborted");
    expect(outcome).toBe("resolved");
  });

  it("keeps the first loss's reason when the socket reports more than one", async () => {
    // A drop can surface as a disconnect and then an error; the operator needs
    // the reason the run actually stopped for.
    const starts = new TransactionStarts();
    starts.lose("first");
    starts.lose("second");
    await expect(starts.lost(sleep(5_000))).rejects.toThrow(/first/);
    await expect(starts.lost(sleep(5_000))).rejects.not.toThrow(/second/);
  });
});

describe("anchoring the stagger to a run-wide epoch (#302)", () => {
  const PERIOD = 60_000;

  it("puts a phase on the run-wide grid however late its cohort arrives", () => {
    // The finding: global indices fix *which* fraction of the period a charge
    // point gets, not what that fraction is measured from. A cohort armed
    // 25s into the run used to start its phase-0 charge point 25s off the
    // grid every other cohort was on.
    expect(firstCycleDelayMs(0, 0, PERIOD)).toBe(0);
    expect(firstCycleDelayMs(0, 25_000, PERIOD)).toBe(35_000);
    expect(firstCycleDelayMs(30_000, 25_000, PERIOD)).toBe(5_000);
    // Already past this period's slot: take the next one, never a negative
    // delay (which `setTimeout` would fire immediately, back into the burst).
    expect(firstCycleDelayMs(10_000, 25_000, PERIOD)).toBe(45_000);
  });

  it("lands every cohort on the same grid, whenever each was armed", () => {
    // Two charge points at the same index must fire at the same wall-clock
    // instants no matter which step created them, and two at different
    // indices must stay apart. Arming delays are arbitrary on purpose.
    for (const elapsed of [0, 137, 25_000, 60_000, 143_991]) {
      for (const index of [0, 1, 2, 5, 17]) {
        const phase = staggerOffsetsMs(index, 1, 60)[0]!;
        const fireAt =
          (elapsed + firstCycleDelayMs(phase, elapsed, PERIOD)) % PERIOD;
        // The absolute instant is the charge point's phase, every time.
        expect(fireAt).toBeCloseTo(phase % PERIOD, 6);
      }
    }
  });

  it("always returns a delay inside one period", () => {
    for (const elapsed of [0, 1, 59_999, 60_000, 1_000_000]) {
      for (const phase of [0, 1, 30_000, 59_999]) {
        const d = firstCycleDelayMs(phase, elapsed, PERIOD);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThan(PERIOD);
      }
    }
  });

  it("degenerates safely when there is no cycle", () => {
    expect(firstCycleDelayMs(0, 1_234, 0)).toBe(0);
  });
});

describe("end-of-window connectivity (#302)", () => {
  const base = {
    requested: 10,
    fleet: 10,
    notSettled: 0,
    aggregate: mergeHistogramDeltas(new Map()),
    heartbeat: null,
    timeouts: 0,
    evictions: 0,
    errors: 0,
    reconnects: 0,
    unconfirmedStarts: 0,
    lateHolds: 0,
    retired: 0,
  };

  it("reports the fleet that generated the histogram, not the one that settled", () => {
    // The finding: a charge point lost during the warmup or the window still
    // counted as connected, so the row claimed N connected while the histogram
    // covered only the survivors.
    const r: StepResult = { ...base, connectedAtSettle: 10, connectedAtEnd: 7 };
    const cells = row(r);
    expect(cells[STEP_COLUMNS.indexOf("connected")]).toBe("7");
    expect(cells[STEP_COLUMNS.indexOf("dropped")]).toBe("3");
    expect(droppedDuringWindow(r)).toBe(3);
  });

  it("shows nothing dropped when the fleet held up", () => {
    const r: StepResult = {
      ...base,
      connectedAtSettle: 10,
      connectedAtEnd: 10,
    };
    expect(row(r)[STEP_COLUMNS.indexOf("dropped")]).toBe("0");
  });

  it("never reports a negative drop when the fleet grew back", () => {
    // A charge point that reconnected inside the window can leave the end
    // count above the settle count; that is not "-2 dropped".
    const r: StepResult = { ...base, connectedAtSettle: 8, connectedAtEnd: 10 };
    expect(droppedDuringWindow(r)).toBe(0);
    expect(row(r)[STEP_COLUMNS.indexOf("connected")]).toBe("10");
  });
});

describe("machine attribution (#302)", () => {
  const facts = {
    cpuModel: "Test CPU",
    cores: 8,
    memGb: "16.0",
    platform: "linux",
    arch: "x64",
    bunVersion: "1.4.0",
    daemonVersion: "9.9.9",
  };

  it("recognises a daemon on this machine", () => {
    for (const url of [
      "http://localhost:9700",
      "http://127.0.0.1:9700",
      "https://127.5.5.5:9700",
      "http://[::1]:9700",
    ]) {
      expect(daemonIsLocal(url)).toBe(true);
    }
  });

  it("treats anything else — including an unparseable URL — as remote", () => {
    // Over-claiming that this runner's hardware is the daemon's is the failure
    // worth avoiding, so anything not provably local is remote.
    for (const url of [
      "http://bench-host.internal:9700",
      "http://10.0.0.5:9700",
      "http://127x.evil.test:9700",
      "not a url",
    ]) {
      expect(daemonIsLocal(url)).toBe(false);
    }
  });

  it("claims the hardware as the daemon host only when the daemon is local", () => {
    const local = machineReport({
      ...facts,
      daemonUrl: "http://127.0.0.1:9700",
    });
    expect(local).toContain("machine (daemon host, and this runner): Test CPU");
    expect(local).not.toContain("UNKNOWN");
  });

  it("refuses to pass the runner off as the machine under test", () => {
    // The README's contract is that a published ceiling names the machine it
    // was measured on, so a wrong attribution is quotable and false — worse
    // than a missing one.
    const remote = machineReport({
      ...facts,
      daemonUrl: "http://bench-host.internal:9700",
    });
    expect(remote).toContain("NOT the daemon host");
    expect(remote).toContain("daemon host: UNKNOWN");
    expect(remote).toContain("bench-host.internal:9700");
    expect(remote).not.toContain("machine (daemon host");
  });
});

describe("what teardown is allowed to delete (#302)", () => {
  const RUN = "test-run";
  const offered = [benchCpId(RUN, 1), benchCpId(RUN, 2), benchCpId(RUN, 3)];

  it("NEVER deletes a pre-existing charge point whose id collided", () => {
    // The destructive bug. Under --allow-existing, a charge point somebody
    // else created that already holds BENCH000001 makes `cp.create_many`
    // report that id as failed *because it already exists* — and teardown then
    // deleted it, destroying a fleet this run never created.
    const survivor = benchCpId(RUN, 1);
    const keep = cleanupIdsAfterBatch(offered, {
      created: [benchCpId(RUN, 2), benchCpId(RUN, 3)],
      failed: [{ cpId: survivor, reason: "charge point already exists" }],
    });
    expect(keep).not.toContain(survivor);
    expect(keep).toEqual([benchCpId(RUN, 2), benchCpId(RUN, 3)]);
  });

  it("drops every explicitly-failed id, whatever the reason given", () => {
    // The daemon does not register a charge point it reports as failed:
    // createOneCp throws before creating on a collision, and the
    // blueprint-defaults path rolls back with removeChargePoint first. So the
    // reason text is not what makes the id safe — the ack naming it is.
    const keep = cleanupIdsAfterBatch(offered, {
      created: [benchCpId(RUN, 3)],
      failed: [
        { cpId: benchCpId(RUN, 1), reason: "already exists" },
        { cpId: benchCpId(RUN, 2), reason: "some other failure" },
      ],
    });
    expect(keep).toEqual([benchCpId(RUN, 3)]);
  });

  it("keeps every offered id while the outcome is unknown", () => {
    // An RPC deadline or a dropped connection does not tell the daemon to
    // stop, so it may hold charge points whose ids never reached this
    // process. Over-listing is free: `cp.delete` answering `not_found`
    // already counts as success.
    expect(cleanupIdsAfterBatch(offered, null)).toEqual(offered);
  });

  it("still deletes everything the daemon says it created", () => {
    const keep = cleanupIdsAfterBatch(offered, {
      created: [...offered],
      failed: [],
    });
    expect(keep).toEqual(offered);
  });

  it("adopts a created id this run did not predict", () => {
    // benchCpId drifting from the daemon's expandIdPattern would otherwise
    // leave real charge points behind for the next run's preflight to refuse.
    const surprise = "SURPRISE-1";
    const keep = cleanupIdsAfterBatch(offered, {
      created: [...offered, surprise],
      failed: [],
    });
    expect(keep).toContain(surprise);
    expect(unpredictedCreatedIds(offered, [...offered, surprise])).toEqual([
      surprise,
    ]);
  });

  it("lets 'created' win over 'failed' for the same id", () => {
    // Contradictory acks should not be resolved in the deleting direction,
    // but an id the daemon says it created must still be cleaned up.
    const keep = cleanupIdsAfterBatch([], {
      created: ["ODD-1"],
      failed: [{ cpId: "ODD-1", reason: "contradictory" }],
    });
    expect(keep).toContain("ODD-1");
  });

  it("reports no unpredicted ids when the pattern matches", () => {
    expect(unpredictedCreatedIds(offered, [benchCpId(RUN, 1)])).toEqual([]);
  });
});

describe("credentials never reach stderr (#302)", () => {
  it("redacts userinfo from the hardware block's daemon host", () => {
    // stderr commonly ends up in a CI log; --out was already redacted.
    const facts = {
      cpuModel: "Test CPU",
      cores: 8,
      memGb: "16.0",
      platform: "linux",
      arch: "x64",
      bunVersion: "1.4.0",
      daemonVersion: "9.9.9",
    };
    // Unparseable, so the fallback path is what renders the host.
    const report = machineReport({
      ...facts,
      daemonUrl: "http://admin:hunter2@bad url:9700",
    });
    expect(report).not.toContain("hunter2");
    expect(report).toContain("***");
  });
});

describe("the in-flight semaphore (#302)", () => {
  it("never lets a late acquire barge a permit meant for a waiter", async () => {
    // The bug, exactly: `release()` used to publish the permit (`available++`)
    // and only then wake the waiter, whose continuation runs a microtask
    // later. An `acquire()` arriving inside that gap took the published permit,
    // and the woken waiter decremented as well — so both ran, `available` went
    // negative and stayed wrong, and concurrency exceeded the cap that exists
    // to keep this script under the daemon's INFLIGHT_CAP.
    const sem = new Semaphore(1);
    const releaseFirst = await sem.acquire();

    let waiterHasPermit = false;
    void sem.acquire().then(() => {
      waiterHasPermit = true;
    });

    // Release, then barge in the same tick — before the waiter's continuation
    // has had a chance to run.
    releaseFirst();
    let bargerHasPermit = false;
    void sem.acquire().then(() => {
      bargerHasPermit = true;
    });

    await sleep(20);
    // One permit exists, so exactly one of them may hold it.
    expect([waiterHasPermit, bargerHasPermit].filter(Boolean)).toHaveLength(1);
    // And it is the waiter's, because the queue is FIFO.
    expect(waiterHasPermit).toBe(true);
  });

  it("holds concurrency at the limit under sustained contention", async () => {
    const limit = 3;
    const sem = new Semaphore(limit);
    let live = 0;
    let peak = 0;
    const task = async (): Promise<void> => {
      const release = await sem.acquire();
      live++;
      peak = Math.max(peak, live);
      await sleep(2);
      live--;
      release();
    };
    // Started in waves rather than all at once, so acquisitions keep arriving
    // while releases are happening — the condition the barge needs.
    const running: Promise<void>[] = [];
    for (let wave = 0; wave < 6; wave++) {
      for (let i = 0; i < 5; i++) running.push(task());
      await sleep(1);
    }
    await Promise.all(running);
    expect(peak).toBeLessThanOrEqual(limit);
    expect(live).toBe(0);
    // The pool is reusable afterwards: a leaked or negative permit count would
    // either hang this or admit instantly past the limit.
    const release = await sem.acquire();
    release();
  });
});

describe("explaining a create failure (#302)", () => {
  it("names the candidate causes when the daemon gives only a code", () => {
    // `createFailureReason` answers `err.message || err.code`, and the
    // already-exists collision carries no message. After a line that also says
    // "this run did not create it", a bare `invalid_params` reads like a
    // collision even when it was a bad --csms-url.
    const hint = createFailureHint("invalid_params");
    expect(hint).toContain("already exists");
    expect(hint).toContain("--csms-url");
    expect(hint).toContain("--ocpp-version");
  });

  it("stays quiet when the daemon gave real text", () => {
    expect(createFailureHint("tlsCaPath does not exist: /etc/nope.pem")).toBe(
      "",
    );
    expect(createFailureHint("charge point already exists")).toBe("");
  });

  it("covers the other bare codes the control plane returns", () => {
    for (const code of ["not_found", "internal", "timeout"]) {
      expect(createFailureHint(code)).not.toBe("");
    }
  });
});

describe("the three interacting requirements on start confirmation (#302)", () => {
  // Three properties now constrain the same handful of lines, and each was a
  // separate review round. They are listed together because satisfying any two
  // of them is what produced the previous two findings.
  //
  //   R1 (round 3) a straggling conf from the PREVIOUS cycle must not confirm
  //                this one;
  //   R2 (round 9) the stop must not fire while the id is the placeholder;
  //   R3 (round 10) a conf that arrives after this cycle's timeout must not
  //                confirm a LATER cycle.

  it("R1/R3: a timeout reports null, which is what makes the caller retire", async () => {
    // R1 and R3 are no longer enforced by inspecting the id's value — they
    // cannot be, now that 0 is a legal assignment. They hold because a cycle
    // whose assigned id times out reports `transactionId: null`, and the
    // caller retires that charge point rather than arming it again. With no
    // later waiter, a straggling conf has nothing to confirm: it is the
    // absence of a waiter, not a test on the number, that protects both.
    const starts = new TransactionStarts();
    const armed = starts.arm("CP-A", 30, true);
    starts.confirm("CP-A", 0);
    const outcome = await armed;
    expect(outcome.started).toBe(true);
    expect(outcome.transactionId).toBe(null); // the retirement signal

    // A straggler arriving now finds nothing armed, which is the state the
    // caller guarantees by not arming a retired charge point again.
    starts.confirm("CP-A", 4242);
    expect(starts.isAvailable).toBe(true);
  });

  it("R2: the wait runs to the assigned id, not the placeholder", async () => {
    const starts = new TransactionStarts();
    const armed = starts.arm("CP-A", 5_000, true);
    starts.confirm("CP-A", 0);
    let settled = false;
    void armed.then(() => {
      settled = true;
    });
    await sleep(20);
    expect(settled).toBe(false);
    starts.confirm("CP-A", 55);
    expect((await armed).transactionId).toBe(55);
  });

  it("R3: the retirement signal is distinguishable from a real assignment", async () => {
    // The whole of R3 now rests on the caller being able to tell "no id
    // arrived" from "an id arrived and it was 0". If those two collapsed onto
    // one value the caller would either retire charge points that were fine
    // (the CSMS-assigns-zero bug) or keep cycling ones whose straggling conf
    // can still confuse a later cycle.
    const timedOut = new TransactionStarts();
    const a = timedOut.arm("CP-A", 30, true);
    timedOut.confirm("CP-A", 0);
    expect((await a).transactionId).toBe(null);

    const assignedZero = new TransactionStarts();
    const b = assignedZero.arm("CP-B", 5_000, true);
    assignedZero.confirm("CP-B", 0);
    assignedZero.confirm("CP-B", 0);
    expect((await b).transactionId).toBe(0);
  });

  it("reports when the transaction actually began, for the hold to run from", async () => {
    // The round-ten finding: starting the hold timer when the id was confirmed
    // added the whole StartTransaction.conf latency to every transaction's
    // on-time, so the duty cycle stopped matching the configuration.
    const starts = new TransactionStarts();
    const armed = starts.arm("CP-A", 5_000, true);
    starts.confirm("CP-A", 0, 1_000);
    starts.confirm("CP-A", 77, 4_000);
    const outcome = await armed;
    expect(outcome.localStartAtMs).toBe(1_000);
    // Three seconds of conf latency, which a one-second hold has already
    // outlasted — the caller stops at once and records it rather than holding
    // a further second on top.
    expect(outcome.transactionId).toBe(77);
  });

  it("keeps the first local start's time when the placeholder repeats", async () => {
    const starts = new TransactionStarts();
    const armed = starts.arm("CP-A", 5_000, true);
    starts.confirm("CP-A", 0, 1_000);
    starts.confirm("CP-A", 0, 2_500);
    starts.confirm("CP-A", 5, 3_000);
    expect((await armed).localStartAtMs).toBe(1_000);
  });

  it("reports no local-start time when nothing started", async () => {
    const starts = new TransactionStarts();
    expect((await starts.arm("CP-A", 20, true)).localStartAtMs).toBe(null);
  });
});

describe("a row discloses a duty cycle that slipped (#302)", () => {
  const base: StepResult = {
    requested: 2,
    fleet: 2,
    connectedAtSettle: 2,
    connectedAtEnd: 2,
    notSettled: 0,
    aggregate: mergeHistogramDeltas(new Map()),
    heartbeat: null,
    timeouts: 0,
    evictions: 0,
    errors: 0,
    reconnects: 0,
    unconfirmedStarts: 0,
    lateHolds: 0,
    retired: 0,
  };

  it("has one cell per column", () => {
    expect(row(base)).toHaveLength(STEP_COLUMNS.length);
  });

  it("shows transactions held longer than configured", () => {
    const cells = row({ ...base, lateHolds: 4 });
    expect(cells[STEP_COLUMNS.indexOf("late hold")]).toBe("4");
  });

  it("shows charge points withdrawn from the cycle", () => {
    // Retiring one drops the fleet's offered load for the rest of the run, so
    // the row has to say so rather than reporting a load it no longer applies.
    const cells = row({ ...base, retired: 1 });
    expect(cells[STEP_COLUMNS.indexOf("retired")]).toBe("1");
  });
});

describe("per-charge-point idTags (#302)", () => {
  const RUN_A = "m1a2b3c-9f2x";
  const RUN_B = "m1a2b3c-7k4p";

  it("gives every charge point in a run a different tag", () => {
    // All of them presenting DEFAULT_ID_TAG made a CSMS that enforces
    // per-idTag concurrency answer ConcurrentTx to every concurrent start
    // after the first, so the run applied a fraction of the load it reported.
    const tags = new Set(
      Array.from({ length: 500 }, (_, i) => benchIdTag(RUN_A, i + 1)),
    );
    expect(tags.size).toBe(500);
  });

  it("keeps two runs against one CSMS out of each other's way", () => {
    expect(benchIdTag(RUN_A, 1)).not.toBe(benchIdTag(RUN_B, 1));
  });

  it("is deterministic, so the traffic stays replayable", () => {
    expect(benchIdTag(RUN_A, 42)).toBe(benchIdTag(RUN_A, 42));
  });

  it("fits OCPP 1.6's CiString20 IdToken", () => {
    // 20 is the wire limit, not a style choice: a longer tag is invalid on the
    // wire and a conforming CSMS may reject the Authorize outright.
    for (const index of [1, 999, 999_999, MAX_FLEET_SIZE]) {
      const tag = benchIdTag(newRunId(Date.now()), index);
      expect(tag.length).toBeLessThanOrEqual(MAX_ID_TAG_LENGTH);
      expect(tag.length).toBeGreaterThan(0);
    }
  });

  it("stays printable ASCII, whatever the run id looked like", () => {
    expect(benchIdTag("weird/id:with@stuff", 7)).toMatch(/^[A-Za-z0-9]+$/);
  });
});

describe("credentials never reach an error message (#302)", () => {
  it("redacts userinfo from a URL too malformed to parse", () => {
    // `ws://user:secret@` is exactly the shape that makes `new URL` throw, and
    // the message goes to stderr, which commonly ends up in a CI log.
    let message = "";
    try {
      validateOptions(
        parseArgv([
          "--csms-url",
          "ws://user:secret@",
          "--daemon-url",
          "http://127.0.0.1:9700",
        ]),
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("is not a valid URL");
    expect(message).not.toContain("secret");
    expect(message).toContain("***");
  });

  it("still redacts a well-formed URL that fails the scheme check", () => {
    let message = "";
    try {
      validateOptions(
        parseArgv([
          "--csms-url",
          "http://user:secret@example.test/ocpp",
          "--daemon-url",
          "http://127.0.0.1:9700",
        ]),
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain("secret");
  });
});

describe("proving a StopTransaction actually left the queue (#302)", () => {
  const exposition = [
    "# TYPE ocppcp_ocpp_messages_total counter",
    'ocppcp_ocpp_messages_total{action="StopTransaction",direction="cp-to-csms"} 7',
    'ocppcp_ocpp_messages_total{action="StopTransaction",direction="csms-to-cp"} 5',
    'ocppcp_ocpp_messages_total{action="StartTransaction",direction="cp-to-csms"} 9',
    'ocppcp_ocpp_messages_total{action="Heartbeat",direction="cp-to-csms"} 40',
  ].join("\n");

  it("counts only the StopTransaction CALLs the daemon actually sent", () => {
    // The `stop_transaction` RPC ack says the daemon *queued* the CALL. Under
    // a backlogged serializer — the condition this tool exists to create —
    // deleting the charge point on that ack discards the queued frame and the
    // CSMS keeps an open transaction. This counter moves when the frame is
    // written, so it is the signal the ack does not give.
    expect(stopTransactionsSent(parseExposition(exposition))).toBe(7);
  });

  it("does not count the answers coming back", () => {
    // `csms-to-cp` is the conf, not a CALL this daemon sent; counting it would
    // let teardown believe frames had left that never did.
    const onlyAnswers = parseExposition(
      'ocppcp_ocpp_messages_total{action="StopTransaction",direction="csms-to-cp"} 5',
    );
    expect(stopTransactionsSent(onlyAnswers)).toBe(0);
  });

  it("does not count other actions", () => {
    const onlyStarts = parseExposition(
      'ocppcp_ocpp_messages_total{action="StartTransaction",direction="cp-to-csms"} 9',
    );
    expect(stopTransactionsSent(onlyStarts)).toBe(0);
  });

  it("is zero on a daemon that has sent none", () => {
    expect(stopTransactionsSent(parseExposition(""))).toBe(0);
  });
});

describe("the complete cycle bound (#302)", () => {
  it("covers every stage a cycle can await in", () => {
    // The bound has grown twice, so the enumeration is asserted rather than
    // trusted: the start RPC, the confirmation wait, the hold, the stop RPC.
    // Nothing else in `cycle` awaits — arming is synchronous and the next
    // cycle is scheduled after the body returns.
    // 1.6 at --tx-interval 2: both RPC stages, the assigned-id wait, the hold.
    expect(cycleBoundMs(ASSIGNED_ID_TIMEOUT_MS, holdSec(2) * 1000)).toBe(
      RPC_DEADLINE_MS + 45_000 + 1_000 + RPC_DEADLINE_MS,
    );
    // The previous bound omitted both RPC stages, so it was short by a full
    // 70s — long enough for an emitted start or stop to take effect after the
    // fleet had been deleted.
    const previous = ASSIGNED_ID_TIMEOUT_MS + holdSec(2) * 1000;
    expect(
      cycleBoundMs(ASSIGNED_ID_TIMEOUT_MS, holdSec(2) * 1000) - previous,
    ).toBe(2 * RPC_DEADLINE_MS);
    // And it must be exactly the four stages, so dropping one fails here.
    for (const confirmMs of [
      START_CONFIRM_TIMEOUT_MS,
      ASSIGNED_ID_TIMEOUT_MS,
    ]) {
      const holdMs = holdSec(60) * 1000;
      const bound = cycleBoundMs(confirmMs, holdMs);
      expect(bound).toBeGreaterThan(confirmMs + holdMs);
      expect(bound).toBe(confirmMs + holdMs + 2 * RPC_DEADLINE_MS);
    }
  });
});
