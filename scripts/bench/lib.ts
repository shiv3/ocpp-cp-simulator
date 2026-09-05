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

/** Prefix shared by every charge point this tool has ever created. Used to
 *  recognise leftovers from an earlier run, which is the one thing a run id
 *  cannot do for itself. */
export const BENCH_ID_ROOT = "BENCH";

/**
 * A fresh run id: `<base36 ms>-<4 random base36>`.
 *
 * **This is the primary defence against deleting somebody else's charge
 * points**, and it is a stronger one than reasoning about acks correctly.
 * Every run creates its charge points under ids no other run can have offered,
 * so a pre-existing charge point *cannot* collide with an id this run offers,
 * and "the benchmark deleted something it did not create" stops being a case
 * that has to be got right and becomes one that cannot arise. The cleanup
 * bookkeeping in {@link cleanupIdsAfterBatch} stays honest as a second line,
 * not as the only one.
 *
 * Randomness here is *identity*, not behaviour: it names charge points and
 * never influences the traffic pattern, so the project's "seeded and
 * replayable" rule is untouched — the stagger, the cycle and every other
 * observable remain deterministic. The value is printed on stderr and recorded
 * in `--out` so a leftover fleet can always be traced back to the run that
 * made it. The timestamp keeps ids sorting in run order; the random tail
 * covers two runs starting in the same millisecond.
 */
export function newRunId(
  nowMs: number,
  random: () => number = Math.random,
): string {
  const stamp = Math.floor(nowMs).toString(36);
  let tail = "";
  for (let i = 0; i < 4; i++) {
    tail += Math.floor(random() * 36)
      .toString(36)
      .slice(-1);
  }
  return `${stamp}-${tail}`;
}

/** The `idPattern` a run creates its charge points under, e.g.
 *  `BENCH-m1a2b3c-9f2x-{n:06}`.
 *
 *  The run id sits in the pattern rather than being appended after the index
 *  so that the daemon's own `expandIdPattern` produces exactly what
 *  {@link benchCpId} predicts — the run must be able to name the ids of a
 *  batch whose `cp.create_many` never answered, since an RPC deadline can
 *  reject the call *after* the daemon created the charge points. */
export function benchIdPattern(runId: string): string {
  return `${BENCH_ID_ROOT}-${runId}-{n:06}`;
}

/** Expand {@link benchIdPattern} for one index.
 *
 *  A deliberate local copy of what `expandIdPattern` in
 *  `src/protocol/methods.ts` does for this one pattern: importing that module
 *  would pull zod and the whole protocol graph into a bench project whose
 *  point is to be dependency-free. The authority is still the daemon, so
 *  `growFleet` compares every answered batch's real ids against the predicted
 *  ones and says so loudly if they ever diverge. */
export function benchCpId(runId: string, index: number): string {
  return `${BENCH_ID_ROOT}-${runId}-${String(index).padStart(6, "0")}`;
}

/**
 * The longest idTag this tool will mint. OCPP 1.6's `IdToken` is a
 * `CiString20Type`, so 20 characters is the wire limit, not a style choice.
 */
export const MAX_ID_TAG_LENGTH = 20;

/**
 * A distinct, deterministic idTag for the charge point at global index
 * `index`.
 *
 * **Every charge point presenting the same tag is a load bug, not a cosmetic
 * one.** Without this they all fell back to `DEFAULT_ID_TAG` (`123456`), and a
 * CSMS that enforces per-idTag concurrency — which is conforming behaviour —
 * answers `ConcurrentTx` to every concurrent start after the first. The
 * benchmark would then apply a fraction of the transaction load it reports,
 * which is the same failure as the pool throttle and the stagger rotation
 * arriving from outside the harness for once.
 *
 * The run-id fragment keeps two runs against one CSMS from colliding with each
 * other; the index keeps the charge points within a run apart. Both are
 * deterministic, so the traffic stays replayable.
 */
export function benchIdTag(runId: string, index: number): string {
  const tail = runId.replace(/[^0-9a-z]/gi, "").slice(-6);
  return `BT${tail}${String(index).padStart(6, "0")}`.slice(
    0,
    MAX_ID_TAG_LENGTH,
  );
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

/** The pool's whole-call RPC deadline, covering admission and acknowledgement.
 *  Mirrors `RPC_TIMEOUT_MS` in `fleet-bench.ts`, which is where the pool that
 *  enforces it lives. */
export const RPC_DEADLINE_MS = 35_000;

/**
 * The longest a single transaction cycle may legitimately take.
 *
 * Enumerated stage by stage, because this bound has grown twice and the next
 * reader deserves to check the sum rather than trust it. A cycle awaits in
 * exactly four places:
 *
 *  1. the `start_transaction` RPC — {@link RPC_DEADLINE_MS};
 *  2. the confirmation wait — `confirmTimeoutMs`
 *     ({@link START_CONFIRM_TIMEOUT_MS} on 2.x,
 *     {@link ASSIGNED_ID_TIMEOUT_MS} on 1.6);
 *  3. the hold — `holdMs`;
 *  4. the `stop_transaction` RPC — {@link RPC_DEADLINE_MS} again.
 *
 * Arming is synchronous and the next cycle is scheduled after the body
 * returns, so there is no fifth. The RPC stages are what the previous bound
 * omitted: a cycle could leave the confirmation wait and then sit in the pool
 * for a further 35s, so teardown stopped waiting and deleted the fleet while
 * an already-emitted start or stop was still in flight.
 *
 * Summed, not maxed. Stages 1 and 2 overlap in practice, but a teardown bound
 * that is too large only costs time when something is genuinely stuck, while
 * one that is too small loses transactions.
 */
export function cycleBoundMs(confirmTimeoutMs: number, holdMs: number): number {
  return RPC_DEADLINE_MS + confirmTimeoutMs + holdMs + RPC_DEADLINE_MS;
}

/**
 * How long a cycle waits for the **CSMS-assigned** transaction id, on the
 * versions that supply one.
 *
 * Bounded by the same reasoning as {@link START_CONFIRM_TIMEOUT_MS}: past the
 * point where the daemon itself has given up, no id is ever coming, so waiting
 * longer buys nothing. Here that is the authorization wait plus the per-CALL
 * watchdog — once `StartTransaction` has been abandoned
 * ({@link CALL_WATCHDOG_SEC}) its conf will never arrive — plus slack. A CSMS
 * that simply never answers therefore stalls one cycle by this much and then
 * proceeds; it cannot hang the run.
 */
export const ASSIGNED_ID_TIMEOUT_MS =
  (AUTHORIZE_WAIT_SEC + CALL_WATCHDOG_SEC + START_CONFIRM_MARGIN_SEC) * 1000;

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
    // Redacted even though the URL did not parse — especially then. A value
    // like `ws://user:secret@` is exactly what makes `new URL` throw, and this
    // message goes to stderr, which commonly ends up in a CI log. The
    // redaction is a regex over the raw text and needs no valid URL.
    throw new BenchValidationError(
      `--${flag} is not a valid URL: ${redactUrlUserinfo(raw)}`,
    );
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
/** Frames actually written to the wire, by action and direction. Used to tell
 *  "the daemon queued this CALL" from "the CALL left the queue". */
export const MESSAGES_METRIC = "ocppcp_ocpp_messages_total";

/**
 * How many `StopTransaction` CALLs this daemon has actually sent.
 *
 * The `stop_transaction` RPC ack only says the daemon *queued* one. Under a
 * backlogged serializer — the condition this tool exists to create — deleting
 * a charge point on the strength of that ack discards the queued CALL, and the
 * CSMS keeps an open transaction after an apparently clean teardown. This
 * counter moves when the frame is written, so waiting for it to rise is
 * waiting for the thing the ack does not promise.
 */
export function stopTransactionsSent(samples: readonly Sample[]): number {
  return samples
    .filter(
      (s) =>
        s.name === MESSAGES_METRIC &&
        s.labels.action === "StopTransaction" &&
        s.labels.direction === "cp-to-csms",
    )
    .reduce((sum, s) => sum + s.value, 0);
}

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
/**
 * A counting semaphore that **hands a released permit straight to the next
 * waiter** instead of publishing it as available.
 *
 * The difference is not cosmetic. Publishing first — `available++`, then wake
 * a waiter — leaves the permit visible for the whole gap between the wake-up
 * and the waiter's continuation actually running, which is a microtask away.
 * An `acquire()` arriving inside that gap took the permit, and the woken
 * waiter then decremented as well, so both ran: concurrency exceeded the
 * limit, `available` went negative, and it stayed wrong for the rest of the
 * run. That defeated the whole point of the cap — staying under the daemon's
 * `INFLIGHT_CAP` — and did so exactly under the contention this benchmark
 * exists to create, where late-arriving acquisitions are the norm.
 *
 * With the hand-off there is no gap: a permit either belongs to a running
 * holder or to a specific woken waiter, and a barging `acquire()` sees
 * `available === 0` and queues behind it. That also makes the queue FIFO,
 * which the publishing version silently was not.
 */
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
    // Deliberately no decrement: `release()` transferred the permit rather
    // than publishing it, so it was never added back in the first place.
    return () => this.release();
  }
  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Straight to the waiter; `available` never rises, so nothing can barge.
      next();
      return;
    }
    this.available++;
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
  /** Charge points connected when the step finished settling, i.e. before the
   *  warmup and the measurement window. */
  readonly connectedAtSettle: number;
  /** Charge points connected in the **final** scrape — the fleet that actually
   *  generated the histogram this row reports. Reporting the settle-time count
   *  attributed a window's latency to a fleet larger than the one producing
   *  it whenever a charge point dropped during warmup or the window, and a
   *  warmup disconnect is invisible otherwise: its reconnect attempts land
   *  before the `before` scrape, so even the `reconnects` column stays 0. */
  readonly connectedAtEnd: number;
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
  /** Transactions whose confirmation alone outlasted the configured hold, so
   *  they were already on longer than asked for by the time they could be
   *  stopped. A non-zero value means this row's duty cycle is not the
   *  configured one. */
  readonly lateHolds: number;
  /** Charge points withdrawn from the transaction cycle because the CSMS never
   *  assigned a transaction id inside the bound. The fleet's offered load
   *  falls by this much from then on. */
  readonly retired: number;
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

/** Charge points that were connected when the step settled but not when it
 *  ended: lost during the warmup or the measurement window. Reported next to
 *  the end-of-window `connected` so both ends of the step are explicit rather
 *  than one standing in for the other. */
export function droppedDuringWindow(r: StepResult): number {
  return Math.max(0, r.connectedAtSettle - r.connectedAtEnd);
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
    String(r.connectedAtEnd),
    String(droppedDuringWindow(r)),
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
    String(r.lateHolds),
    String(r.retired),
  ];
}

/** Header row for {@link row}. Kept beside it so a column added to one is
 *  a compile error in the other rather than a silently shifted table. */
export const STEP_COLUMNS = [
  "N",
  "uncreated",
  "connected",
  "dropped",
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
  "late hold",
  "retired",
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
export interface TransactionStartOutcome {
  /** Whether the transaction was observed to start at all. */
  readonly started: boolean;
  /** The CSMS-assigned transaction id, when one was waited for and arrived.
   *  `0` means the local start was seen but the id is still the placeholder;
   *  `null` means nothing was confirmed. */
  readonly transactionId: number | null;
  /** When the transaction began *locally*, from the placeholder emission.
   *
   *  The hold is measured from here, never from when the id was confirmed.
   *  Starting the hold timer after the assigned id arrived added the whole
   *  `StartTransaction.conf` latency to every transaction's on-time — near the
   *  knee, seconds on top of a configured one-second hold — so the duty cycle
   *  stopped matching the configuration and the active-axis numbers described
   *  a load nobody asked for. `null` when no local start was seen. */
  readonly localStartAtMs: number | null;
}

/**
 * Which emission this waiter is expecting next.
 *
 * **Explicit, rather than inferred from the id's value.** The daemon emits
 * `transaction_started` twice per 1.6 transaction — once locally, once when
 * `StartTransaction.conf` supplies the assigned id — and this used to tell
 * them apart by testing `transactionId === 0`. That is wrong on the protocol:
 * OCPP 1.6's `transactionId` is schema-valid for any integer, zero included,
 * so a CSMS that assigns 0 was never recognised and its charge point was
 * retired after the full timeout despite a valid confirmation. The phase is
 * the run's own state and owes nothing to the number on the wire.
 */
type StartPhase = "awaiting-local-start" | "awaiting-assigned-id";

interface StartWaiter {
  settle(outcome: TransactionStartOutcome): void;
  /** `Date.now()` at the local start emission, or `null` before it. */
  localStartAtMs: number | null;
  /** Which emission is expected next. Ordering, not value, separates them. */
  phase: StartPhase;
  /** Whether this cycle must wait for the assigned id before proceeding. */
  readonly awaitAssignedId: boolean;
}

/** Nothing was observed: no local start, no id. */
const UNCONFIRMED: TransactionStartOutcome = {
  started: false,
  transactionId: null,
  localStartAtMs: null,
};

export class TransactionStarts {
  private readonly waiters = new Map<string, StartWaiter>();
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

  /**
   * Arm a waiter for `cpId`, to be settled by {@link confirm}.
   *
   * `awaitAssignedId` is what reconciles two requirements that pull against
   * each other. OCPP 1.6 emits `transaction_started` **twice**: once when the
   * transaction begins locally, carrying the placeholder id `0`, and again
   * when `StartTransaction.conf` supplies the CSMS-assigned id.
   *
   * - A late conf from the *previous* cycle must not confirm this one. Taking
   *   only the first emission satisfied that.
   * - But the stop must not fire while the id is still `0`.
   *   `OCPPMessageHandler.sendStopTransaction` snapshots the id immediately,
   *   so stopping early sends the placeholder and produces CALLERRORs and
   *   corrupted connector state — worst near the latency knee, where a conf
   *   routinely outlasts a hold.
   *
   * Binding the waiter to its own cycle satisfies both. A non-zero id is
   * accepted only once this waiter has seen its own local start, so a
   * straggling conf from an earlier cycle is ignored rather than mistaken for
   * this one's; and the wait then continues to the assigned id rather than
   * stopping at the placeholder.
   *
   * `awaitAssignedId` is false where no assigned id is coming — OCPP 2.x never
   * sets the numeric id, so waiting for one there would time out every cycle
   * and stretch the cadence for nothing.
   */
  arm(
    cpId: string,
    timeoutMs: number,
    awaitAssignedId: boolean,
  ): Promise<TransactionStartOutcome> {
    if (!this.available) {
      return Promise.resolve(UNCONFIRMED);
    }
    return new Promise<TransactionStartOutcome>((resolve) => {
      const timer = setTimeout(() => {
        if (this.waiters.get(cpId) === waiter) this.waiters.delete(cpId);
        // A local start seen but no id is still a start — report it, so the
        // caller can tell "never started" from "started, id never assigned".
        // The two need different handling: the second leaves a conf that may
        // still arrive, the first leaves nothing behind.
        resolve(
          waiter.phase === "awaiting-assigned-id"
            ? {
                started: true,
                // Started, but no assigned id arrived. `null` says exactly
                // that, where 0 could not: 0 is a legal assignment.
                transactionId: null,
                localStartAtMs: waiter.localStartAtMs,
              }
            : UNCONFIRMED,
        );
      }, timeoutMs);
      const waiter: StartWaiter = {
        phase: "awaiting-local-start",
        localStartAtMs: null,
        awaitAssignedId,
        settle: (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        },
      };
      // One connector per benchmarked charge point and one cycle at a time, so
      // a second armed waiter for the same id can only be a bug; drop the older
      // one rather than leaking it.
      this.waiters.get(cpId)?.settle(UNCONFIRMED);
      this.waiters.set(cpId, waiter);
    });
  }

  /**
   * One `transaction_started` event for `cpId`, carrying whatever id it had.
   *
   * `transactionId === 0` is the local start; anything else is the assigned id
   * arriving with `StartTransaction.conf`. An unknown charge point is ignored —
   * a confirmation with no waiter is a normal race, not an error.
   */
  confirm(cpId: string, transactionId: number, nowMs = Date.now()): void {
    const waiter = this.waiters.get(cpId);
    if (!waiter) return;

    if (waiter.phase === "awaiting-local-start") {
      // The first emission after arming is this cycle's local start, whatever
      // id it carries. A straggler from an earlier cycle cannot be it: a
      // second emission only exists after a confirmation timeout, and a cycle
      // that timed out retires its charge point, so no later waiter is ever
      // armed for it (see `TransactionStartOutcome` and the retirement path in
      // `fleet-bench.ts`).
      waiter.localStartAtMs = nowMs;
      if (!waiter.awaitAssignedId) {
        this.waiters.delete(cpId);
        waiter.settle({
          started: true,
          transactionId,
          localStartAtMs: nowMs,
        });
        return;
      }
      waiter.phase = "awaiting-assigned-id";
      return;
    }

    // The second emission is `StartTransaction.conf`'s assigned id. Accepted
    // whatever its value — zero is a legal assignment, and testing for it was
    // what made a CSMS assigning 0 unrecognisable.
    //
    // KNOWN LIMITATION, not fixable from here: against a CSMS that assigns
    // `transactionId: 0` this second emission never arrives at all.
    // `CLIChargePointService` suppresses the `transactionIdChange` it would
    // come from (`src/cli/service.ts`, `if (transactionId === 0) return`), so
    // the wait times out and the charge point is retired despite a valid
    // confirmation — the fleet's offered load drops, visibly in the `retired`
    // column but for the wrong reason. Tracked as issue #328; the fix is in
    // the daemon's event contract, not in this script.
    this.waiters.delete(cpId);
    waiter.settle({
      started: true,
      transactionId,
      localStartAtMs: waiter.localStartAtMs,
    });
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
    for (const waiter of this.waiters.values()) waiter.settle(UNCONFIRMED);
    this.waiters.clear();
  }
}

/**
 * Delay before a charge point's *first* transaction cycle, so that its phase
 * is measured from a **run-wide epoch** rather than from whenever its own
 * cohort finished arming.
 *
 * Global indices fixed *which* fraction of the period each charge point gets;
 * they did nothing about what that fraction is measured from. The load is
 * armed once per sweep step, and creation, settling and heartbeat arming all
 * take variable time, so each cohort's offsets used to be rotated by an
 * arbitrary amount relative to the cohorts already cycling. Two charge points
 * with well-separated indices could still collide in wall-clock phase, which
 * is the artificial-knee failure the stagger exists to prevent, reached by
 * another route.
 *
 * Rebasing modulo the period fixes the origin as well as the sequence: index
 * `i` means the same instant whichever step created it. The result is always
 * in `[0, periodMs)` — the next occurrence of that phase on the run-wide grid.
 */
export function firstCycleDelayMs(
  phaseMs: number,
  elapsedSinceEpochMs: number,
  periodMs: number,
): number {
  if (periodMs <= 0) return Math.max(0, phaseMs);
  const delay = (phaseMs - elapsedSinceEpochMs) % periodMs;
  return delay < 0 ? delay + periodMs : delay;
}

/** Hosts that mean "this machine". `URL.hostname` keeps IPv6 literals in
 *  brackets, hence both spellings of the loopback address. */
const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
]);

/** Whether `--daemon-url` names a daemon on the machine running this script.
 *  A URL that will not parse is treated as remote: over-claiming that the
 *  hardware below belongs to the daemon is the failure worth avoiding. */
export function daemonIsLocal(daemonUrl: string): boolean {
  try {
    const host = new URL(daemonUrl).hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host) || host.startsWith("127.");
  } catch {
    return false;
  }
}

export interface MachineFacts {
  readonly daemonUrl: string;
  readonly cpuModel: string;
  readonly cores: number;
  readonly memGb: string;
  readonly platform: string;
  readonly arch: string;
  readonly bunVersion: string;
  readonly daemonVersion: string;
}

/**
 * The hardware block a run reports, honest about **whose** hardware it is.
 *
 * `os.cpus()`, `os.totalmem()` and `Bun.version` describe the process running
 * this script. With `--daemon-url` pointing at another host that is not the
 * machine under test, and labelling it `machine:` made a recorded ceiling
 * name the wrong hardware. Since the README's whole contract is that a
 * published number names the machine it was measured on, a wrong attribution
 * is worse than a missing one: it is quotable and false. So a remote run says
 * plainly that the daemon host is unknown rather than presenting the runner
 * as it.
 */
export function machineReport(facts: MachineFacts): string {
  const hardware = `${facts.cpuModel} (${facts.cores} cores), ${facts.memGb} GiB RAM, ${facts.platform}/${facts.arch}`;
  const versions = `bun: ${facts.bunVersion}, daemon: ${facts.daemonVersion}`;
  if (daemonIsLocal(facts.daemonUrl)) {
    return [
      `machine (daemon host, and this runner): ${hardware}`,
      versions,
    ].join("\n");
  }
  let host = redactUrlUserinfo(facts.daemonUrl);
  try {
    // `URL.host` already excludes userinfo; the redaction covers the fallback,
    // since this block is printed to stderr and stderr reaches CI logs.
    host = new URL(facts.daemonUrl).host;
  } catch {
    // Keep the (redacted) raw string; it is only quoted back at the operator.
  }
  return [
    `benchmark client, NOT the daemon host: ${hardware}`,
    versions,
    `daemon host: UNKNOWN — --daemon-url points at ${host}, so the hardware ` +
      `above is this runner's and says nothing about the machine under test. ` +
      `Record the daemon host's CPU/RAM/OS by hand before publishing a ceiling.`,
  ].join("\n");
}

/** What `cp.create_many` answers: a partial batch is a normal result, so both
 *  lists matter. */
export interface CreateManyAck {
  readonly created: readonly string[];
  readonly failed: readonly {
    readonly cpId: string;
    /** Carried for the operator's benefit only. The decision below turns on
     *  the ack naming the id at all, never on why. */
    readonly reason?: string;
  }[];
}

/**
 * Which of a batch's offered ids the run may still delete at teardown.
 *
 * The two cases are genuinely different and were wrongly treated alike:
 *
 * - **`ack === null` — indeterminate.** The RPC hit its deadline or lost its
 *   connection. The daemon was never told to stop, so it may hold charge
 *   points whose ids never reached this process. Every offered id stays: an
 *   id we did not create answers `not_found` on delete, which cleanup already
 *   counts as success, so over-listing costs nothing while under-listing
 *   leaves charge points the next run's preflight refuses.
 *
 * - **An ack naming failures — determinate.** Now we *know*. A `failed` entry
 *   means the daemon did not register that charge point: `createOneCp` throws
 *   before creating anything on an id collision, and the blueprint-defaults
 *   path rolls the charge point back with `removeChargePoint` before reporting
 *   it. Keeping such an id was **destructive**: under `--allow-existing`, a
 *   pre-existing charge point already holding an offered id like
 *   `BENCH000001` is reported as failed *because it already exists*, and
 *   deleting it at teardown destroys a fleet this run never created.
 *
 * The asymmetry is deliberate. Keeping an id we did not create risks a leak,
 * which is recoverable — the preflight refuses the daemon and an operator
 * deletes it. Deleting a charge point we did not create is not recoverable.
 * So an id leaves this set only on positive evidence that it was never ours,
 * and the one sliver where that evidence could be wrong (a rollback whose own
 * `removeChargePoint` failed) is left to leak rather than to delete.
 *
 * Ids the daemon reports as created but this run did not predict are added:
 * cleanup must cover them, and their appearance means `benchCpId` has drifted
 * from the daemon's own `expandIdPattern`.
 */
export function cleanupIdsAfterBatch(
  offered: readonly string[],
  ack: CreateManyAck | null,
): string[] {
  if (ack === null) return [...offered];
  const notOurs = new Set(ack.failed.map((f) => f.cpId));
  const keep = offered.filter((id) => !notOurs.has(id));
  const predicted = new Set(offered);
  for (const id of ack.created) {
    // A created id is ours whatever we predicted — and `notOurs` must never
    // veto it, since "created" is the stronger evidence.
    if (!predicted.has(id)) keep.push(id);
  }
  return keep;
}

/** Ids `cp.create_many` reported creating that this run never offered — proof
 *  that {@link benchCpId} and the daemon's `expandIdPattern` disagree. */
export function unpredictedCreatedIds(
  offered: readonly string[],
  created: readonly string[],
): string[] {
  const predicted = new Set(offered);
  return created.filter((id) => !predicted.has(id));
}

/** RPC error codes the daemon returns as a bare code, with no message behind
 *  them: `createFailureReason` falls back to `err.code` when the failure
 *  carries no text. */
const BARE_RPC_CODES = new Set([
  "invalid_params",
  "not_found",
  "internal",
  "timeout",
  "rate_limited",
  "unauthorized",
]);

/**
 * An extra sentence for a `cp.create_many` failure whose reason is a bare
 * error code.
 *
 * `createFailureReason` in `src/cli/server/socketServer.ts` answers
 * `err.message || err.code`, and the already-exists collision carries no
 * message — so the operator sees `invalid_params` and nothing else. That code
 * covers several unrelated causes, and after a run that also printed "this run
 * did not create it" the bare code reads like a collision even when it was a
 * bad `--csms-url` or `--ocpp-version`. Naming the candidates is the
 * difference between a line that diagnoses and a line that misleads.
 *
 * Returns `""` when the daemon gave real text, which needs no help.
 */
export function createFailureHint(reason: string): string {
  if (!BARE_RPC_CODES.has(reason.trim())) return "";
  return (
    ` — the daemon gave no detail beyond "${reason.trim()}", which covers an id` +
    ` that already exists on it, a --csms-url it rejects, and an --ocpp-version` +
    ` it will not create; check the daemon's own log to tell them apart`
  );
}
