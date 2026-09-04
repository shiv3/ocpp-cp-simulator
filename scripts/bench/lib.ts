// Pure logic for fleet-bench.ts: flag validation, the Prometheus text
// exposition parser, before/after histogram diffing, and quantile
// interpolation. Kept dependency-free (no socket.io, no fs, no network) so
// it can be unit-tested without a daemon or CSMS running — see
// lib.bun.test.ts.

/** Fleet sizes above this are almost certainly a typo, not a plan — the
 *  daemon enforces no hard cap on registered charge points, but this script
 *  does, an order of magnitude past `CP_CREATE_MANY_MAX` (200) and far past
 *  anything a CI fleet asks for. Raise it deliberately, not by accident. */
export const MAX_FLEET_SIZE = 2000;

/** How many N values one sweep may cover. Each point costs a full settle +
 *  measurement window, so an unbounded list turns a typo into an hours-long
 *  run. */
export const MAX_SWEEP_POINTS = 20;

export const MIN_DURATION_SEC = 5;
export const MAX_DURATION_SEC = 3600;
export const MIN_INTERVAL_SEC = 1;
export const MAX_INTERVAL_SEC = 3600;
export const MIN_SETTLE_TIMEOUT_SEC = 1;
export const MAX_SETTLE_TIMEOUT_SEC = 600;
/** Bytes/characters, matching the caps `STR_64K`/`STR_1K`-shaped fields use
 *  elsewhere in the control plane (`src/protocol/limits.ts`) — a URL is
 *  identifier-shaped, not a payload, so 2048 is generous. */
export const MAX_URL_LENGTH = 2048;

export interface DaemonBasicAuth {
  readonly username: string;
  readonly password: string;
}

export interface BenchOptions {
  readonly csmsUrl: string;
  readonly daemonUrl: string;
  /** Ascending, de-duplicated fleet sizes to sweep, e.g. [10, 50, 100]. Each
   *  step creates only the delta since the previous step. */
  readonly counts: readonly number[];
  /** Measurement window per step, once the step's new CPs have settled. */
  readonly durationSec: number;
  /** Explicit heartbeat cadence applied to every CP via `start_heartbeat`,
   *  overriding whatever interval the CSMS's BootNotification.conf sent —
   *  so a run is comparable across CSMS peers. */
  readonly heartbeatIntervalSec: number;
  /** 0 = idle axis (heartbeat only). >0 = active axis: each CP cycles
   *  start_transaction/stop_transaction on connector 1 at roughly this
   *  period, staggered across CPs. */
  readonly txIntervalSec: number;
  /** How long to wait for a step's newly-created CPs to report connected
   *  before giving up on the stragglers and measuring anyway. */
  readonly settleTimeoutSec: number;
  readonly healthPath: string;
  readonly daemonBasicAuth: DaemonBasicAuth | null;
  readonly outFile: string | null;
}

export class BenchValidationError extends Error {}

interface RawArgValue {
  readonly value: string;
}

/** argv (already stripped of `bun`/script path) to a `--flag value` map.
 *  Boolean-only flags are not needed here; every flag this script defines
 *  takes a value. */
export function parseArgv(argv: readonly string[]): Map<string, RawArgValue> {
  const out = new Map<string, RawArgValue>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) {
      throw new BenchValidationError(`unrecognized argument: ${arg}`);
    }
    const name = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new BenchValidationError(`--${name} requires a value`);
    }
    out.set(name, { value });
    i++;
  }
  return out;
}

function requireInt(
  raw: Map<string, RawArgValue>,
  name: string,
  fallback: number | undefined,
  bounds: readonly [number, number],
): number {
  const entry = raw.get(name);
  if (!entry) {
    if (fallback === undefined) {
      throw new BenchValidationError(`--${name} is required`);
    }
    return fallback;
  }
  const n = Number(entry.value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new BenchValidationError(`--${name} must be an integer`);
  }
  const [min, max] = bounds;
  if (n < min || n > max) {
    throw new BenchValidationError(
      `--${name} must be between ${min} and ${max}`,
    );
  }
  return n;
}

function parseCounts(raw: string): number[] {
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.length === 0 || parts.some((p) => p.length === 0)) {
    throw new BenchValidationError(
      "--counts must be a comma-separated list of integers",
    );
  }
  if (parts.length > MAX_SWEEP_POINTS) {
    throw new BenchValidationError(
      `--counts may name at most ${MAX_SWEEP_POINTS} points, got ${parts.length}`,
    );
  }
  const counts = parts.map((p) => {
    const n = Number(p);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      throw new BenchValidationError(
        `--counts entry "${p}" is not a positive integer`,
      );
    }
    if (n > MAX_FLEET_SIZE) {
      throw new BenchValidationError(
        `--counts entry ${n} exceeds this script's cap of ${MAX_FLEET_SIZE}`,
      );
    }
    return n;
  });
  for (let i = 1; i < counts.length; i++) {
    if (counts[i]! <= counts[i - 1]!) {
      throw new BenchValidationError(
        "--counts must be strictly ascending (each step grows the fleet)",
      );
    }
  }
  return counts;
}

function parseUrl(
  raw: string,
  flag: string,
  schemes: readonly string[],
): string {
  if (raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    throw new BenchValidationError(
      `--${flag} must be 1..${MAX_URL_LENGTH} characters`,
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BenchValidationError(`--${flag} is not a valid URL: ${raw}`);
  }
  const scheme = url.protocol.replace(/:$/, "");
  if (!schemes.includes(scheme)) {
    throw new BenchValidationError(
      `--${flag} must use ${schemes.join(" or ")}, got "${scheme}:"`,
    );
  }
  return raw;
}

/** Parse and bounds-check every flag. Throws {@link BenchValidationError}
 *  with a message meant to be printed directly — no side effect happens
 *  until every flag has been validated (standing lesson: no side effect
 *  before validation). */
export function validateOptions(raw: Map<string, RawArgValue>): BenchOptions {
  const csmsUrl = parseUrl(requireString(raw, "csms-url"), "csms-url", [
    "ws",
    "wss",
    "http",
    "https",
  ]);
  const daemonUrlRaw = parseUrl(
    requireString(raw, "daemon-url"),
    "daemon-url",
    ["http", "https"],
  );
  const daemonUrl = daemonUrlRaw.replace(/\/+$/, "");

  const countsRaw = raw.get("counts")?.value ?? "10,50,100,200";
  const counts = parseCounts(countsRaw);

  const durationSec = requireInt(raw, "duration", 60, [
    MIN_DURATION_SEC,
    MAX_DURATION_SEC,
  ]);
  const heartbeatIntervalSec = requireInt(raw, "heartbeat-interval", 5, [
    MIN_INTERVAL_SEC,
    MAX_INTERVAL_SEC,
  ]);
  const txIntervalSec = requireInt(raw, "tx-interval", 0, [
    0,
    MAX_INTERVAL_SEC,
  ]);
  const settleTimeoutSec = requireInt(raw, "settle-timeout", 60, [
    MIN_SETTLE_TIMEOUT_SEC,
    MAX_SETTLE_TIMEOUT_SEC,
  ]);
  if (durationSec < 2 * heartbeatIntervalSec) {
    throw new BenchValidationError(
      `--duration (${durationSec}s) must be at least twice --heartbeat-interval ` +
        `(${heartbeatIntervalSec}s), or most CPs will contribute at most one sample`,
    );
  }

  const healthPathRaw = raw.get("health-path")?.value ?? "/v1/healthz";
  if (!healthPathRaw.startsWith("/")) {
    throw new BenchValidationError("--health-path must start with '/'");
  }

  const user = raw.get("daemon-basic-auth-user")?.value;
  const pass = raw.get("daemon-basic-auth-pass")?.value;
  if ((user === undefined) !== (pass === undefined)) {
    throw new BenchValidationError(
      "--daemon-basic-auth-user and --daemon-basic-auth-pass must be given together",
    );
  }
  const daemonBasicAuth: DaemonBasicAuth | null =
    user !== undefined && pass !== undefined
      ? { username: user, password: pass }
      : null;

  const outFileRaw = raw.get("out")?.value;
  if (
    outFileRaw !== undefined &&
    (outFileRaw.length === 0 || outFileRaw.length > MAX_URL_LENGTH)
  ) {
    throw new BenchValidationError(
      `--out must be 1..${MAX_URL_LENGTH} characters`,
    );
  }
  const outFile = outFileRaw ?? null;

  return {
    csmsUrl,
    daemonUrl,
    counts,
    durationSec,
    heartbeatIntervalSec,
    txIntervalSec,
    settleTimeoutSec,
    healthPath: healthPathRaw,
    daemonBasicAuth,
    outFile,
  };
}

function requireString(raw: Map<string, RawArgValue>, name: string): string {
  const entry = raw.get(name);
  if (!entry) throw new BenchValidationError(`--${name} is required`);
  return entry.value;
}

// ---------------------------------------------------------------------------
// Prometheus text exposition — parsing and before/after histogram diffing.
// ---------------------------------------------------------------------------

export interface Sample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

const SAMPLE_LINE = /^([A-Za-z_:][A-Za-z0-9_:]*)(\{.*\})?\s+(\S+)$/;

function parseLabels(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const body = raw.slice(1, -1); // strip { }
  const labels: Record<string, string> = {};
  // Labels are `key="value"` pairs separated by commas; values may contain
  // escaped `\"`, `\\` and `\n` (the exact escaping `render.ts` produces).
  const re = /([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const key = m[1]!;
    const value = m[2]!
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
    labels[key] = value;
  }
  return labels;
}

/** Parse a Prometheus text-exposition body (the `/metrics` response) into a
 *  flat sample list. `# HELP` / `# TYPE` / blank lines are skipped; anything
 *  else that fails to parse is skipped too, rather than throwing — a scrape
 *  racing a daemon restart should degrade, not crash the whole sweep. */
export function parseExposition(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const m = SAMPLE_LINE.exec(trimmed);
    if (!m) continue;
    const value = Number(m[3]);
    if (!Number.isFinite(value)) continue;
    samples.push({ name: m[1]!, labels: parseLabels(m[2]), value });
  }
  return samples;
}

export function findSamples(
  samples: readonly Sample[],
  name: string,
): Sample[] {
  return samples.filter((s) => s.name === name);
}

export function counterValue(
  samples: readonly Sample[],
  name: string,
  labels: Readonly<Record<string, string>> = {},
): number {
  let total = 0;
  for (const s of samples) {
    if (s.name !== name) continue;
    if (Object.entries(labels).every(([k, v]) => s.labels[k] === v)) {
      total += s.value;
    }
  }
  return total;
}

export interface HistogramBucketDelta {
  readonly le: number;
  readonly count: number;
}

export interface HistogramSeriesDelta {
  readonly action: string;
  /** Finite buckets, ascending `le`, cumulative counts (delta over the
   *  window — still cumulative, since a cumulative counter's difference
   *  over a window is itself a cumulative distribution of that window). */
  readonly buckets: readonly HistogramBucketDelta[];
  readonly sum: number;
  /** Total samples in the window (equals the `+Inf` bucket's delta). */
  readonly count: number;
}

/** A counter delta can only be negative if the daemon restarted mid-window
 *  (Prometheus counters never decrease otherwise). Clamped to 0 rather than
 *  reported negative or thrown — a restart mid-sweep should show up as
 *  suspiciously low counts, not crash the report. */
function clampedDelta(before: number, after: number): number {
  return Math.max(0, after - before);
}

/** Diff two scrapes of one histogram metric, per `action` label, returning
 *  only actions present in `after`. Buckets missing from `before` (a brand
 *  new action label) are treated as starting at 0. */
export function diffHistogram(
  before: readonly Sample[],
  after: readonly Sample[],
  metricName: string,
): Map<string, HistogramSeriesDelta> {
  const bucketName = `${metricName}_bucket`;
  const sumName = `${metricName}_sum`;
  const countName = `${metricName}_count`;

  const afterBuckets = findSamples(after, bucketName);
  const actions = new Set(afterBuckets.map((s) => s.labels.action ?? ""));

  const result = new Map<string, HistogramSeriesDelta>();
  for (const action of actions) {
    const les = new Set<string>();
    for (const s of afterBuckets) {
      if ((s.labels.action ?? "") === action) les.add(s.labels.le ?? "");
    }
    const buckets: HistogramBucketDelta[] = [];
    let infCount = 0;
    for (const leRaw of les) {
      const beforeVal = counterValue(before, bucketName, { action, le: leRaw });
      const afterVal = counterValue(after, bucketName, { action, le: leRaw });
      const delta = clampedDelta(beforeVal, afterVal);
      if (leRaw === "+Inf") {
        infCount = delta;
      } else {
        const le = Number(leRaw);
        if (Number.isFinite(le)) buckets.push({ le, count: delta });
      }
    }
    buckets.sort((a, b) => a.le - b.le);
    const sum = clampedDelta(
      counterValue(before, sumName, { action }),
      counterValue(after, sumName, { action }),
    );
    const count = clampedDelta(
      counterValue(before, countName, { action }),
      counterValue(after, countName, { action }),
    );
    result.set(action, { action, buckets, sum, count: count || infCount });
  }
  return result;
}

/** Merge per-action deltas into one series (all actions share the same
 *  fixed bucket edges — `CALL_DURATION_BUCKETS_SECONDS` in
 *  `src/cli/server/metrics/MetricsRecorder.ts` — so summing counts per `le`
 *  across actions is a valid histogram merge). */
export function mergeHistogramDeltas(
  deltas: ReadonlyMap<string, HistogramSeriesDelta>,
): HistogramSeriesDelta {
  const byLe = new Map<number, number>();
  let sum = 0;
  let count = 0;
  for (const series of deltas.values()) {
    for (const b of series.buckets) {
      byLe.set(b.le, (byLe.get(b.le) ?? 0) + b.count);
    }
    sum += series.sum;
    count += series.count;
  }
  const buckets = [...byLe.entries()]
    .map(([le, c]) => ({ le, count: c }))
    .sort((a, b) => a.le - b.le);
  return { action: "*", buckets, sum, count };
}

export type QuantileResult =
  | { readonly kind: "value"; readonly seconds: number }
  /** The quantile falls past the last finite bucket edge (the `+Inf`
   *  bucket) — there is no upper edge to interpolate against, so this is
   *  reported as "past the last bucket" rather than a fabricated number. */
  | { readonly kind: "overflow"; readonly lastEdge: number }
  | { readonly kind: "no-data" };

/** Linear-interpolation histogram quantile, the same approximation
 *  Prometheus's own `histogram_quantile()` uses: assume samples are
 *  uniformly distributed within each bucket. Resolution is bounded by the
 *  fixed bucket edges (`CALL_DURATION_BUCKETS_SECONDS`); a quantile that
 *  lands inside a wide bucket (e.g. 5s..10s) is only as precise as that
 *  bucket is narrow. */
export function histogramQuantile(
  series: HistogramSeriesDelta,
  q: number,
): QuantileResult {
  if (series.count <= 0) return { kind: "no-data" };
  const target = q * series.count;
  let prevLe = 0;
  let prevCount = 0;
  for (const { le, count } of series.buckets) {
    if (target <= count) {
      if (count === prevCount) return { kind: "value", seconds: le };
      const frac = (target - prevCount) / (count - prevCount);
      return { kind: "value", seconds: prevLe + frac * (le - prevLe) };
    }
    prevLe = le;
    prevCount = count;
  }
  return { kind: "overflow", lastEdge: prevLe };
}

export function formatSeconds(q: QuantileResult): string {
  if (q.kind === "no-data") return "-";
  if (q.kind === "overflow") return `>${q.lastEdge}s`;
  return q.seconds < 1
    ? `${(q.seconds * 1000).toFixed(0)}ms`
    : `${q.seconds.toFixed(2)}s`;
}

// ---------------------------------------------------------------------------
// Small concurrency helpers shared by the orchestrator.
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Simple token bucket: `ratePerSec` tokens/second, refilled continuously,
 *  capped at `ratePerSec` (no burst beyond one second's worth). Used to keep
 *  this script's own control-plane RPC traffic under the daemon's per-socket
 *  `RPC_RATE_PER_SEC` (`src/protocol/limits.ts`), which bounds how fast the
 *  bench can arm CPs, not the OCPP traffic being measured. */
export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(private readonly ratePerSec: number) {
    this.tokens = ratePerSec;
  }
  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      const elapsed = (now - this.last) / 1000;
      this.tokens = Math.min(
        this.ratePerSec,
        this.tokens + elapsed * this.ratePerSec,
      );
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.max(1, 1000 / this.ratePerSec));
    }
  }
}

/** Counting semaphore bounding concurrent in-flight work, so this script
 *  stays under the daemon's per-socket `INFLIGHT_CAP`. */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];
  constructor(count: number) {
    this.available = count;
  }
  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.available--;
    return () => this.release();
  }
  private release(): void {
    this.available++;
    const next = this.waiters.shift();
    if (next) next();
  }
}

// ---------------------------------------------------------------------------
// Table formatting.
// ---------------------------------------------------------------------------

/** Right-pad-free, left-aligned column table — good enough for a terminal
 *  and for pasting into a markdown doc as-is (columns are `|`-free so it is
 *  not literally a markdown table; see the README for why). */
export function formatTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i]!))
      .join("  ")
      .trimEnd();
  return [
    line(headers),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map(line),
  ].join("\n");
}
