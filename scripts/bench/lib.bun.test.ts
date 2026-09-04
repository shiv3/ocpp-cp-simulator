// Unit tests for the pure logic in lib.ts — flag validation, the Prometheus
// exposition parser, and histogram diffing/quantile math. Runs under `bun
// test` (picked up by `bun.test` name filter, see package.json's `test:bun`).
import { describe, expect, it } from "bun:test";
import {
  BenchValidationError,
  MAX_FLEET_SIZE,
  MAX_SWEEP_POINTS,
  Semaphore,
  TokenBucket,
  assertDaemonEmpty,
  diffHistogram,
  fleetGauge,
  formatSeconds,
  formatTable,
  histogramQuantile,
  mergeHistogramDeltas,
  parseArgv,
  parseExposition,
  redactOptions,
  redactUrlUserinfo,
  validateOptions,
  type Sample,
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
    // `growFleet` passes only `wsUrl`, so the daemon defaults to OCPP-1.6J:
    // an http(s) URL used to produce a WebSocket fleet against an HTTP
    // endpoint while the flag documentation promised SOAP.
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
