// Pure logic for fleet-bench.ts: flag validation, the Prometheus text
// exposition parser, before/after histogram diffing, and quantile
// interpolation. Kept dependency-free (no socket.io, no fs, no network) so
// it can be unit-tested without a daemon or CSMS running — see
// lib.bun.test.ts.
import {
  OCPP_1_6,
  SUPPORTED_OCPP_VERSIONS,
  isSoapVersion,
  type OcppVersion,
} from "../../src/cp/domain/types/OcppVersion.ts";

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

/** `OCPPMessageHandler.SERIAL_CALL_TIMEOUT_MS`, in seconds: how long after a
 *  CALL its watchdog fires and `ocppcp_ocpp_call_timeouts_total` increments.
 *  Every timeout in a scrape delta therefore belongs to a CALL sent one
 *  watchdog interval earlier, which is what {@link recommendedWarmupSec}
 *  exists to keep inside the step being measured. */
export const CALL_WATCHDOG_SEC = 30;

/** Upper bound on `--warmup`. One watchdog interval past the longest
 *  transaction period, so the computed default is always expressible. */
export const MAX_WARMUP_SEC = MAX_INTERVAL_SEC + CALL_WATCHDOG_SEC;

/** The OCPP versions this benchmark can drive.
 *
 *  OCPP-J only, and for the same reason `--csms-url` takes only `ws(s)://`:
 *  `ocppcp_ocpp_call_duration_seconds` is derived from the JSON frames the
 *  WebSocket transport logs, and a SOAP exchange carries no message id to
 *  correlate a response back with — a SOAP fleet would report an empty
 *  latency table. Derived from `SUPPORTED_OCPP_VERSIONS` rather than
 *  restated, so a version added to the simulator is not silently missing
 *  here. */
export const BENCH_OCPP_VERSIONS: readonly OcppVersion[] =
  SUPPORTED_OCPP_VERSIONS.filter((v) => !isSoapVersion(v));

/** The `idPattern` every benchmarked charge point is created under.
 *
 *  Kept here beside {@link benchCpId} because the run must be able to name the
 *  ids of a batch whose `cp.create_many` never answered: an RPC deadline or a
 *  dropped connection can reject the call *after* the daemon created the
 *  charge points, and ids that never reach the client are ids the cleanup
 *  sweep cannot delete — leaving a daemon the next run's preflight refuses. */
export const BENCH_ID_PATTERN = "BENCH{n:06}";

/** Expand {@link BENCH_ID_PATTERN} for one index.
 *
 *  A deliberate local copy of what `expandIdPattern` in
 *  `src/protocol/methods.ts` does for this one pattern: importing that module
 *  would pull zod and the whole protocol graph into a bench project whose
 *  point is to be dependency-free. The authority is still the daemon, so
 *  `growFleet` compares every answered batch's real ids against the predicted
 *  ones and says so loudly if they ever diverge. */
export function benchCpId(index: number): string {
  return `BENCH${String(index).padStart(6, "0")}`;
}

/** Control-plane RPC budget per pooled socket, per second.
 *
 *  Kept under the daemon's `RPC_RATE_PER_SEC` (100), which `socketServer`
 *  meters **per connection** (`SocketRpcState.tokens`), so the pool's total
 *  budget grows with the socket count rather than being shared. This script's
 *  own control-plane traffic must never get itself rate-limited or be mistaken
 *  for the thing being measured. */
export const RPC_RATE_PER_SOCKET = 80;

/** Hard cap on pooled control-plane sockets. Ten connections is already an
 *  unusual client; past it the bench is a load generator against the control
 *  plane rather than a measurement of the OCPP wire. */
export const MAX_SOCKETS = 10;

/** Charge points per socket, before the required RPC rate is taken into
 *  account. See {@link socketPoolSize}. */
export const CPS_PER_SOCKET = 200;

/** Fraction of the pool's nominal RPC budget the transaction load may claim.
 *
 *  Not a fudge factor: a token bucket driven at exactly its refill rate is a
 *  queue at utilisation 1, where every scheduling jitter is absorbed by a
 *  backlog that never drains — the cycle period would drift past
 *  `--tx-interval` and keep drifting, which is the same silent under-load this
 *  ceiling exists to prevent. The remaining fifth also covers the step's own
 *  `start_heartbeat` arming and the end-of-run `cp.delete` sweep, which share
 *  the same buckets. */
export const RPC_HEADROOM = 0.8;

/** How long a transaction is held open, and how long the connector then rests
 *  before the next cycle — the `holdMs` in `fleet-bench.ts`'s `cycle`, in
 *  seconds. Floored at 1s so a 1s `--tx-interval` does not degenerate into a
 *  start and stop in the same tick. */
export function holdSec(txIntervalSec: number): number {
  return Math.max(1, txIntervalSec / 2);
}

/** One charge point's start-to-next-start period, in seconds: a hold plus a
 *  rest. Equal to `--tx-interval` for every interval of 2s or more, and 2s
 *  below that — which is why it, and not the raw flag, is what the required
 *  RPC rate is computed from. */
export function cyclePeriodSec(txIntervalSec: number): number {
  return 2 * holdSec(txIntervalSec);
}

/** Sustained control-plane RPC rate the active axis demands: two calls
 *  (`start_transaction`, `stop_transaction`) per charge point per cycle.
 *  Zero on the idle axis, where the daemon's own timers drive the heartbeats
 *  and the bench issues nothing after arming. */
export function requiredRpcPerSec(n: number, txIntervalSec: number): number {
  if (txIntervalSec <= 0 || n <= 0) return 0;
  return (2 * n) / cyclePeriodSec(txIntervalSec);
}

/** What a pool of `sockets` sockets may sustain, headroom applied. */
export function sustainableRpcPerSec(sockets: number): number {
  return sockets * RPC_RATE_PER_SOCKET * RPC_HEADROOM;
}

/** How many control-plane sockets a run needs: enough for the fleet size *and*
 *  enough for the transaction rate.
 *
 *  Sizing on the fleet alone is what let the pool throttle the load below what
 *  was asked for: 200 charge points fit on one socket, but at
 *  `--tx-interval 2` they demand 200 RPC/s and one socket allows 64, so the
 *  bench applied a third of the configured load and reported the latency of
 *  that smaller load instead. */
export function socketPoolSize(maxN: number, txIntervalSec: number): number {
  const forFleet = Math.ceil(maxN / CPS_PER_SOCKET);
  const forRate = Math.ceil(
    requiredRpcPerSec(maxN, txIntervalSec) / sustainableRpcPerSec(1),
  );
  return Math.min(MAX_SOCKETS, Math.max(1, forFleet, forRate));
}

/** The largest fleet the full socket pool can drive at this `--tx-interval`.
 *  Quoted in the rejection message and in the README's ceiling. */
export function maxSustainableFleet(txIntervalSec: number): number {
  return Math.floor(
    (sustainableRpcPerSec(MAX_SOCKETS) * cyclePeriodSec(txIntervalSec)) / 2,
  );
}

/** The smallest `--tx-interval` at which the full pool can drive `n` charge
 *  points. Integer, because the flag is one. */
export function minSustainableTxIntervalSec(n: number): number {
  return Math.max(2, Math.ceil((2 * n) / sustainableRpcPerSec(MAX_SOCKETS)));
}

/** How long a step should hold the new fleet size and its load before the
 *  `before` scrape: the transaction stagger ramp (one `--tx-interval`, 0 on
 *  the idle axis) plus one CALL watchdog interval.
 *
 *  Without it a step's `timeouts` delta is not the step's: the watchdog fires
 *  {@link CALL_WATCHDOG_SEC} after the CALL, so the delta between the two
 *  scrapes bracketing a window counts expirations for calls issued before the
 *  window opened — during the previous step, or during this step's boot and
 *  ramp. That moved the first non-zero timeout to a larger N than the one
 *  that actually produced it, and finding that N is the whole point. */
export function recommendedWarmupSec(txIntervalSec: number): number {
  // The ramp is one *cycle period*, not one raw `--tx-interval`: they differ at
  // `--tx-interval 1`, where a hold is floored at 1s and the real period is 2s
  // — the same "the flag is not the period" slip that made the pool ceiling
  // overstate its requirement. The idle axis has no cycle and so no ramp,
  // which is why the period is asked for only when there is one: `holdSec`'s
  // 1s floor would otherwise invent a 2s ramp for a fleet that never starts a
  // transaction.
  const rampSec = txIntervalSec > 0 ? cyclePeriodSec(txIntervalSec) : 0;
  return Math.min(MAX_WARMUP_SEC, CALL_WATCHDOG_SEC + rampSec);
}

/**
 * The van der Corput sequence in base 2: `0, ½, ¼, ¾, ⅛, ⅝, ⅜, ⅞, …`.
 *
 * Its defining property is the one a fleet that **grows in place** needs:
 * *every prefix* is near-uniform over `[0, 1)`, not just the whole sequence.
 * A charge point's phase can therefore be fixed once, from its global index,
 * and stay correct as the fleet grows around it — no cohort has to be
 * re-phased, and no cohort has to know how large the fleet will end up.
 */
export function radicalInverseBase2(index: number): number {
  let remaining = Math.floor(Math.abs(index));
  let denominator = 1;
  let result = 0;
  while (remaining > 0) {
    denominator *= 2;
    result += (remaining % 2) / denominator;
    remaining = Math.floor(remaining / 2);
  }
  return result;
}

/**
 * Transaction-cycle start offsets for the charge points at global fleet
 * indices `startIndex .. startIndex + count - 1`, spread across one cycle
 * period. Deterministic, never random.
 *
 * **Global indices, not per-cohort ones.** The fleet is grown in place, so
 * `armLoad` is called once per sweep step with only that step's new charge
 * points. Spacing each cohort evenly across the period *by itself* restarted
 * the phase at 0 for every cohort: with `--counts 1,2,3` and step durations
 * that are multiples of the period, all three charge points ended up in
 * nearly the same phase — a burst, exactly what the stagger exists to prevent,
 * and a latency knee that would be an artefact of this script rather than a
 * property of the daemon. That is the worst failure available to a tool whose
 * entire output is a knee.
 *
 * Exact even spacing (`i/count`) cannot survive growth without re-phasing the
 * whole running fleet, which would mean tearing down in-flight transaction
 * timers and re-issuing `start_transaction` on connectors mid-session. The van
 * der Corput sequence buys the property that matters instead: every prefix is
 * near-uniform, so the fleet is well spread at *every* step of the sweep, with
 * a maximum gap of at most `2 / n` of a period at fleet size `n` — against the
 * `1 / n` of a perfectly even ring, and against the "all in one phase" the
 * per-cohort version produced.
 *
 * The span is the **cycle period**, not the raw `--tx-interval`: a hold is
 * floored at 1s, so at `--tx-interval 1` the period is 2s and spreading over
 * 1s would leave the fleet bunched in half the phase space.
 */
export function staggerOffsetsMs(
  startIndex: number,
  count: number,
  txIntervalSec: number,
): number[] {
  if (count <= 0) return [];
  const spanMs = txIntervalSec <= 0 ? 0 : cyclePeriodSec(txIntervalSec) * 1000;
  return Array.from(
    { length: count },
    (_, i) => radicalInverseBase2(startIndex + i) * spanMs,
  );
}

/**
 * How long `ChargePoint.authorizeAndWait` may take, in seconds — its
 * `timeoutMs` default in `src/cp/domain/charge-point/ChargePoint.ts`.
 *
 * It **never rejects**: on timeout or disconnect it warns and resolves as
 * `"Accepted"`. So a local start is always definitively resolved within this
 * bound — either the transaction begins and `transaction_started` fires, or
 * authorization was denied and it never will.
 */
export const AUTHORIZE_WAIT_SEC = 10;

/** Slack over {@link AUTHORIZE_WAIT_SEC} for the control-plane hop, the
 *  daemon's own scheduling and the event's trip back. */
export const START_CONFIRM_MARGIN_SEC = 5;

/**
 * How long a cycle waits for its `transaction_started` before concluding the
 * start is not happening.
 *
 * Deliberately **not the hold**. `--tx-interval 2` gives a 1s hold while
 * authorization may legitimately take 10s, so a hold-length wait declared the
 * start dead while it was still pending: the stop then fired against a
 * transaction that did not exist, the next cycle began immediately, and the
 * original start landed *after* that ineffective stop — leaving a transaction
 * active, or letting its event confirm a newer cycle's waiter. The row
 * reported `unconf.tx` while the traffic had quietly stopped matching the
 * configured cadence.
 *
 * Because {@link AUTHORIZE_WAIT_SEC} bounds the domain's own resolution, a
 * start still unconfirmed after this really was denied — so a cycle that waits
 * this long has waited for a definitive answer, not merely given up early.
 */
export const START_CONFIRM_TIMEOUT_MS =
  (AUTHORIZE_WAIT_SEC + START_CONFIRM_MARGIN_SEC) * 1000;

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
  /** How long a step holds the new fleet size and its load *before* the
   *  `before` scrape, so every timeout in the step's delta belongs to a CALL
   *  this step issued at this N. Defaults to
   *  {@link recommendedWarmupSec}. */
  readonly warmupSec: number;
  /** OCPP version every benchmarked charge point is created with. Passed to
   *  `cp.create_many`, which otherwise defaults to `OCPP-1.6J` — against a
   *  2.x-only CSMS that made every handshake fail and the run report an
   *  unsettled fleet and no data. One of {@link BENCH_OCPP_VERSIONS}. */
  readonly ocppVersion: OcppVersion;
  readonly healthPath: string;
  readonly daemonBasicAuth: DaemonBasicAuth | null;
  readonly outFile: string | null;
  /** Run even though the daemon already holds charge points this script did
   *  not create. `/metrics` carries no `cpId` label by design, so their
   *  traffic lands in the same histogram as the bench fleet's while `N`
   *  counts only the bench's own — the curve is then not what it says it is.
   *  Off by default; the pre-existing count is recorded when it is on. */
  readonly allowExisting: boolean;
}

export class BenchValidationError extends Error {}

interface RawArgValue {
  readonly value: string;
}

/** Flags taking a value. A name absent from both sets is a typo, not a flag —
 *  `--duraton 5` used to parse fine, never be read, and run with the default. */
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "csms-url",
  "daemon-url",
  "counts",
  "duration",
  "heartbeat-interval",
  "tx-interval",
  "settle-timeout",
  "warmup",
  "ocpp-version",
  "health-path",
  "daemon-basic-auth-user",
  "daemon-basic-auth-pass",
  "out",
]);

/** Flags that are present-or-absent and consume no following argument. */
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["allow-existing"]);

/** argv (already stripped of `bun`/script path) to a `--flag value` map.
 *  Boolean flags map to the empty string. Every name is checked against
 *  {@link VALUE_FLAGS}/{@link BOOLEAN_FLAGS} here, before any side effect:
 *  an unknown flag is a failed run, never a silently ignored one. */
export function parseArgv(argv: readonly string[]): Map<string, RawArgValue> {
  const out = new Map<string, RawArgValue>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) {
      throw new BenchValidationError(`unrecognized argument: ${arg}`);
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      out.set(name, { value: "" });
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      throw new BenchValidationError(`unknown flag: --${name}`);
    }
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
  // OCPP-J only, on purpose. `ocppcp_ocpp_call_duration_seconds` has no SOAP
  // equivalent (a SOAP log line carries no message id to correlate a response
  // back with), so a SOAP fleet would report an empty latency table. Accepting
  // `http(s)://` used to silently produce a 1.6J WebSocket fleet against an
  // HTTP URL — the flag said SOAP and the run measured something else.
  const csmsUrl = parseUrl(requireString(raw, "csms-url"), "csms-url", [
    "ws",
    "wss",
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
  // Defaulted from `--tx-interval`, not fixed: on the active axis the stagger
  // ramp is one interval long, so a fixed 30s warmup would still open the
  // window while half the fleet had yet to issue its first StartTransaction.
  const warmupSec = requireInt(
    raw,
    "warmup",
    recommendedWarmupSec(txIntervalSec),
    [0, MAX_WARMUP_SEC],
  );

  // Rejected rather than defaulted, the same way `--csms-url` rejects an
  // `http(s)://` URL: a SOAP fleet produces no duration observations at all,
  // so the run would report an empty latency table and call it a result.
  const ocppVersionRaw = raw.get("ocpp-version")?.value ?? OCPP_1_6;
  if (!(BENCH_OCPP_VERSIONS as readonly string[]).includes(ocppVersionRaw)) {
    throw new BenchValidationError(
      `--ocpp-version must be one of ${BENCH_OCPP_VERSIONS.join(", ")}, got "${ocppVersionRaw}"` +
        (isSoapVersion(ocppVersionRaw)
          ? ": the SOAP versions carry no message id to correlate a response " +
            "with, so the CALL duration histogram would stay empty"
          : ""),
    );
  }
  const ocppVersion = ocppVersionRaw as OcppVersion;
  // Reject a rate the socket pool cannot sustain, rather than quietly
  // applying less OCPP load than was asked for and reporting the latency of
  // that smaller load. The pool paces every RPC through a per-socket token
  // bucket, and the transaction cycle awaits its RPC before scheduling the
  // next phase, so a required rate above the pool's ceiling does not queue —
  // it stretches the cycle, and the fleet silently runs at a longer interval
  // than the flag says.
  const maxN = counts.at(-1)!;
  const requiredRpc = requiredRpcPerSec(maxN, txIntervalSec);
  const ceilingRpc = sustainableRpcPerSec(MAX_SOCKETS);
  if (requiredRpc > ceilingRpc) {
    throw new BenchValidationError(
      `--counts up to ${maxN} at --tx-interval ${txIntervalSec}s needs ` +
        `${requiredRpc.toFixed(0)} control-plane RPC/s (2 per charge point per ` +
        `${cyclePeriodSec(txIntervalSec)}s cycle), but ${MAX_SOCKETS} sockets ` +
        `sustain ${ceilingRpc.toFixed(0)} RPC/s. The run would apply less load ` +
        `than configured and report the latency of that smaller load. Raise ` +
        `--tx-interval to ${minSustainableTxIntervalSec(maxN)} or more, or cap ` +
        `--counts at ${maxSustainableFleet(txIntervalSec)}`,
    );
  }

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
    warmupSec,
    ocppVersion,
    healthPath: healthPathRaw,
    daemonBasicAuth,
    outFile,
    allowExisting: raw.has("allow-existing"),
  };
}

// ---------------------------------------------------------------------------
// Redaction. A `--out` file is meant to be kept, attached to an issue and
// pasted into a doc, so nothing in it may carry a credential.
// ---------------------------------------------------------------------------

/** `https://user:pass@host/x` to `https://user:***@host/x`. A URL with no
 *  password (or no userinfo at all) comes back unchanged — there is nothing
 *  secret in it, and mangling it would make the record harder to read.
 *
 *  The userinfo class excludes `/?#` but **not** `@`, so the greedy match
 *  backtracks to the LAST `@` before the path — which is the delimiter WHATWG
 *  URL parsing uses. Stopping at the first `@` would leave the tail of a
 *  password containing one (`user:p@ss@host`) in the output, and a partial
 *  leak is still a leak. */
export function redactUrlUserinfo(raw: string): string {
  return raw.replace(
    /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#]*)@/,
    (_all, scheme: string, userinfo: string) => {
      const colon = userinfo.indexOf(":");
      if (colon < 0) return `${scheme}${userinfo}@`;
      return `${scheme}${userinfo.slice(0, colon)}:***@`;
    },
  );
}

/** The options block as it may be written to `--out`: the daemon Basic Auth
 *  password replaced, and userinfo stripped out of both URLs. The username is
 *  kept — it identifies the run, and it is not the secret. */
export function redactOptions(opts: BenchOptions): Record<string, unknown> {
  return {
    ...opts,
    csmsUrl: redactUrlUserinfo(opts.csmsUrl),
    daemonUrl: redactUrlUserinfo(opts.daemonUrl),
    daemonBasicAuth: opts.daemonBasicAuth
      ? { username: opts.daemonBasicAuth.username, password: "***" }
      : null,
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

/** The registered-charge-point gauge, labelled by state. */
export const CHARGE_POINTS_METRIC = "ocppcp_charge_points";
/** The state `ChargePoint.status` takes while disconnected or pre-boot. */
export const UNAVAILABLE_STATE = "Unavailable";

export interface FleetGauge {
  /** Every registered charge point, whatever its state. */
  readonly total: number;
  /** Those past boot — the settle criterion, and bounded/cheap where
   *  `cp.list` is neither (its result schema caps at 1000 entries, so polling
   *  it past that size fails validation and the RPC answers `internal`). */
  readonly connected: number;
}

/** Read `ocppcp_charge_points` out of one scrape. */
export function fleetGauge(samples: readonly Sample[]): FleetGauge {
  let total = 0;
  let connected = 0;
  for (const s of samples) {
    if (s.name !== CHARGE_POINTS_METRIC) continue;
    total += s.value;
    if (s.labels.state !== UNAVAILABLE_STATE) connected += s.value;
  }
  return { total, connected };
}

/** Preflight guard: refuse to measure a daemon that already holds charge
 *  points, because `/metrics` carries no `cpId` label — their traffic would
 *  land in the same histogram as the bench fleet's while the reported `N`
 *  counts only the charge points this script created. Returns the
 *  pre-existing count, which the report and the `--out` file record when
 *  `--allow-existing` waives the refusal. */
export function assertDaemonEmpty(
  samples: readonly Sample[],
  allowExisting: boolean,
): number {
  const { total } = fleetGauge(samples);
  if (total > 0 && !allowExisting) {
    throw new Error(
      `the daemon already holds ${total} charge point(s). Their OCPP traffic ` +
        `would be counted in this run's histogram while N counts only the ` +
        `bench's own fleet, so the N-vs-latency curve would be wrong. Point ` +
        `--daemon-url at a dedicated bench daemon, or pass --allow-existing ` +
        `to run anyway (the count is then recorded in the report).`,
    );
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

// ---------------------------------------------------------------------------
// One sweep step's reported row. Here rather than in fleet-bench.ts because
// that file connects a socket and calls main() on import, so nothing in it can
// be unit-tested; the row's labelling is a claim about what a number describes
// and must be.
// ---------------------------------------------------------------------------

export interface StepResult {
  /** The fleet size this step *asked* for — the `--counts` entry. */
  readonly requested: number;
  /** The fleet size it actually has. `cp.create_many` succeeds partially, so
   *  the two diverge the moment a creation fails, and reporting a row's
   *  latency under `requested` attributes it to a fleet that never existed. */
  readonly fleet: number;
  readonly connected: number;
  readonly notSettled: number;
  readonly aggregate: ReturnType<typeof mergeHistogramDeltas>;
  readonly heartbeat: ReturnType<typeof mergeHistogramDeltas> | null;
  /** Watchdog-abandoned CALLs, or `null` on a transport with no watchdog —
   *  where the honest answer is "not measured", not "zero". */
  readonly timeouts: number | null;
  readonly evictions: number;
  readonly errors: number;
  readonly reconnects: number;
  readonly unconfirmedStarts: number;
}

/** Calls that *answered* later than the last finite bucket edge (30s) — the
 *  `+Inf` bucket's count minus the last finite bucket's cumulative count.
 *
 *  This is emphatically **not** the timeout count. A duration is only observed
 *  when an answer arrives, so a CALL the CSMS never answers contributes
 *  nothing here at all; that is what `ocppcp_ocpp_call_timeouts_total` is for.
 *  A non-zero number in this column means the CSMS answered after the charge
 *  point had already given up on the call. */
export function answeredAfterWatchdog(r: StepResult): number {
  const lastFiniteCount = r.aggregate.buckets.at(-1)?.count ?? 0;
  return Math.max(0, r.aggregate.count - lastFiniteCount);
}

export function row(r: StepResult): string[] {
  const p50 = formatSeconds(histogramQuantile(r.aggregate, 0.5));
  const p95 = formatSeconds(histogramQuantile(r.aggregate, 0.95));
  const hbP50 = r.heartbeat
    ? formatSeconds(histogramQuantile(r.heartbeat, 0.5))
    : "-";
  const hbP95 = r.heartbeat
    ? formatSeconds(histogramQuantile(r.heartbeat, 0.95))
    : "-";
  return [
    String(r.fleet),
    String(r.requested - r.fleet),
    String(r.connected),
    String(r.notSettled),
    String(r.aggregate.count),
    p50,
    p95,
    hbP50,
    hbP95,
    r.timeouts === null ? "n/a" : String(r.timeouts),
    String(answeredAfterWatchdog(r)),
    String(r.errors),
    String(r.reconnects),
    String(r.unconfirmedStarts),
  ];
}

/** Header row for {@link row}. Kept beside it so a column added to one is
 *  a compile error in the other rather than a silently shifted table. */
export const STEP_COLUMNS = [
  "N",
  "uncreated",
  "connected",
  "unsettled",
  "calls",
  "p50",
  "p95",
  "hb p50",
  "hb p95",
  "timeouts",
  "late>30s",
  "errors",
  "reconnects",
  "unconf.tx",
] as const;

// ---------------------------------------------------------------------------
// Transaction-start confirmation, minus the socket.
//
// The socket wiring lives in fleet-bench.ts (this file stays dependency-free so
// it can be unit-tested without a daemon). What lives here is the part with the
// invariants: which cycle is waiting for which charge point, what happens when
// the event stream goes away, and how a run learns to stop.
// ---------------------------------------------------------------------------

/** Thrown when a run cannot go on. Distinct from `BenchValidationError`, which
 *  is a flag problem caught before anything is created. */
export class BenchAbortError extends Error {}

/**
 * Tracks which charge points are waiting for their transaction to start.
 *
 * Two things it must get right, both of them ways a benchmark can quietly stop
 * measuring what it says it measures:
 *
 * 1. A waiter is armed **before** the `start_transaction` RPC is emitted. The
 *    confirmation and the RPC ack travel on different sockets and nothing
 *    orders them, so arming afterwards would drop the event of every fast CSMS.
 * 2. Once the event stream is **lost** the tracker goes unavailable, and every
 *    later `arm` resolves `false` at once instead of burning its full timeout.
 *    Waiting it out doubled a transaction's occupancy — one hold spent waiting
 *    for a confirmation that could never arrive, then the real hold — and
 *    collapsed the rest period, so later rows carried roughly twice the
 *    intended load under the label of the configured one.
 *
 * {@link lost} is the run's own abort signal; a caller races its long waits
 * against it so the sweep stops and says why rather than printing rows whose
 * load is no longer the row's.
 */
export class TransactionStarts {
  private readonly waiters = new Map<string, (started: boolean) => void>();
  private available = true;
  private readonly lostSignal: Promise<never>;
  private failLost: (err: Error) => void = () => {};

  constructor() {
    this.lostSignal = new Promise<never>((_resolve, reject) => {
      this.failLost = reject;
    });
    // Nothing may be racing the signal at the instant it rejects — a drop
    // between two of the caller's waits — and an unobserved rejection is an
    // unhandled-rejection crash whose message is not the one the operator
    // needs to read.
    this.lostSignal.catch(() => {});
  }

  /** Whether confirmations can still arrive. */
  get isAvailable(): boolean {
    return this.available;
  }

  /** Arm a waiter for `cpId`, to be settled by {@link confirm}. Resolves
   *  `false` on timeout, and immediately when the stream is already lost. */
  arm(cpId: string, timeoutMs: number): Promise<boolean> {
    if (!this.available) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiters.get(cpId) === settle) this.waiters.delete(cpId);
        resolve(false);
      }, timeoutMs);
      const settle = (started: boolean): void => {
        clearTimeout(timer);
        resolve(started);
      };
      // One connector per benchmarked charge point and one cycle at a time, so
      // a second armed waiter for the same id can only be a bug; drop the older
      // one rather than leaking it.
      this.waiters.get(cpId)?.(false);
      this.waiters.set(cpId, settle);
    });
  }

  /** One charge point's transaction has started. Unknown ids are ignored —
   *  a confirmation with no waiter is a normal race, not an error. */
  confirm(cpId: string): void {
    const settle = this.waiters.get(cpId);
    if (!settle) return;
    this.waiters.delete(cpId);
    settle(true);
  }

  /** The event stream is gone and cannot come back. Idempotent. */
  lose(reason: string): void {
    if (!this.available) return;
    this.available = false;
    this.failAll();
    this.failLost(new BenchAbortError(reason));
  }

  /** Shut down deliberately, at the end of a run. Never signals {@link lost}:
   *  a run that finished is not a run that was aborted. */
  close(): void {
    this.available = false;
    this.failAll();
  }

  /** `promise`, but rejecting with {@link BenchAbortError} the moment the
   *  event stream is lost. */
  lost<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([promise, this.lostSignal]);
  }

  private failAll(): void {
    for (const settle of this.waiters.values()) settle(false);
    this.waiters.clear();
  }
}
