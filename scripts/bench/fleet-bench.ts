#!/usr/bin/env bun
// Fleet scale benchmark (issue #302). Stands up N charge points against a
// CSMS via `cp.create_many`, drives heartbeats (and, optionally, a
// start/stop transaction cycle) at a configurable rate, and reads the
// daemon's `/metrics` endpoint before and after each step to report where
// per-CP overhead starts distorting OCPP CALL round-trip latency.
//
// See scripts/bench/README.md for usage and docs/entities/daemon.md#limits--roadmap
// for how a run's output is meant to be recorded.
import * as os from "node:os";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { io, type Socket } from "socket.io-client";

import { CP_CREATE_MANY_MAX } from "../../src/protocol/limits.ts";
import {
  BENCH_OCPP_VERSIONS,
  BenchAbortError,
  BenchValidationError,
  CALL_WATCHDOG_SEC,
  RPC_RATE_PER_SOCKET,
  Semaphore,
  TokenBucket,
  answeredAfterWatchdog,
  assertDaemonEmpty,
  BENCH_ID_ROOT,
  benchCpId,
  benchIdPattern,
  benchIdTag,
  cleanupIdsAfterBatch,
  createFailureHint,
  cyclePeriodSec,
  daemonIsLocal,
  diffHistogram,
  droppedDuringWindow,
  firstCycleDelayMs,
  fleetGauge,
  formatTable,
  histogramQuantile,
  holdSec,
  machineReport,
  maxSustainableFleet,
  mergeHistogramDeltas,
  newRunId,
  parseArgv,
  parseExposition,
  recommendedWarmupSec,
  redactOptions,
  redactUrlUserinfo,
  requiredRpcPerSec,
  row,
  sleep,
  socketPoolSize,
  staggerOffsetsMs,
  ASSIGNED_ID_TIMEOUT_MS,
  START_CONFIRM_TIMEOUT_MS,
  TransactionStarts,
  STEP_COLUMNS,
  sustainableRpcPerSec,
  unpredictedCreatedIds,
  validateOptions,
  type BenchOptions,
  type FleetGauge,
  type Sample,
  type StepResult,
  type TransactionStartOutcome,
} from "./lib.ts";
import { OCPP_1_6 } from "../../src/cp/domain/types/OcppVersion.ts";

const CALL_DURATION_METRIC = "ocppcp_ocpp_call_duration_seconds";
const CALL_TIMEOUTS_METRIC = "ocppcp_ocpp_call_timeouts_total";
const PENDING_EVICTIONS_METRIC = "ocppcp_ocpp_pending_calls_evicted_total";

// Per-socket concurrency, kept under the daemon's `INFLIGHT_CAP` (64). The
// matching rate budget, the socket count and the fleet ceiling they imply
// live in lib.ts, where `validateOptions` can refuse a run the pool cannot
// sustain (see the README's "Why a socket pool" section).
const INFLIGHT_PER_SOCKET = 48;
const RPC_TIMEOUT_MS = 35_000;

/** Deadline for every HTTP request this script makes (health, `/metrics`).
 *
 *  `fetch` has no timeout of its own, so a daemon that accepts the connection
 *  and then stalls while serving `/metrics` — precisely the condition at the
 *  top of a sweep, which is what this tool exists to reach — used to hang the
 *  run forever: `--settle-timeout` never fired, the measurement never
 *  finished, and the `finally` that deletes the fleet never ran. Generous
 *  relative to a healthy scrape and in the same range as
 *  {@link RPC_TIMEOUT_MS}, so it bounds a hang without failing a slow but
 *  working daemon. */
const HTTP_TIMEOUT_MS = 30_000;

/** `fetch` with a deadline, and with the URL redacted out of any error it
 *  raises — `--daemon-url` may carry userinfo and these messages reach
 *  stderr, which commonly reaches a CI log. */
async function fetchWithDeadline(
  url: string,
  init: RequestInit,
  what: string,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw new Error(
      timedOut
        ? `${what} did not answer within ${HTTP_TIMEOUT_MS / 1000}s (${redactUrlUserinfo(url)}). ` +
            `A daemon that accepts the connection and then stalls under load would ` +
            `otherwise hang this run forever.`
        : `${what} failed (${redactUrlUserinfo(url)}): ${String(err)}`,
      { cause: err },
    );
  }
}

/** Overall budget for the best-effort `cp.delete` sweep at the end of a run
 *  (and on Ctrl-C). Cleanup used to delete sequentially with the full
 *  {@link RPC_TIMEOUT_MS} per charge point, so a dead daemon turned a 2000-CP
 *  run's teardown into ~19 hours of blocked failure handling and an
 *  unresponsive Ctrl-C. Anything still registered when this elapses is
 *  reported and abandoned. */
const CLEANUP_BUDGET_MS = 60_000;
/** Concurrent `cp.delete` calls during cleanup. Well under the pool's
 *  per-socket `INFLIGHT_PER_SOCKET`, and the token buckets still pace them. */
const CLEANUP_CONCURRENCY = 32;

interface PooledSocket {
  readonly socket: Socket;
  readonly bucket: TokenBucket;
  readonly sem: Semaphore;
}

class RpcFailedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class SocketPool {
  private readonly pooled: PooledSocket[] = [];
  private rr = 0;

  private constructor(pooled: PooledSocket[]) {
    this.pooled = pooled;
  }

  static async connect(
    daemonUrl: string,
    count: number,
    auth: { username: string; password: string } | null,
  ): Promise<SocketPool> {
    const pooled: PooledSocket[] = [];
    const opened: Socket[] = [];
    try {
      for (let i = 0; i < count; i++) {
        const socket = io(daemonUrl, {
          path: "/socket.io/",
          auth: auth ?? undefined,
          reconnection: true,
        });
        opened.push(socket);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`socket ${i} did not connect within 10s`)),
            10_000,
          );
          socket.once("connect", () => {
            clearTimeout(timer);
            resolve();
          });
          socket.once("connect_error", (err: Error) => {
            clearTimeout(timer);
            reject(err);
          });
        });
        pooled.push({
          socket,
          bucket: new TokenBucket(RPC_RATE_PER_SOCKET),
          sem: new Semaphore(INFLIGHT_PER_SOCKET),
        });
      }
    } catch (err) {
      // Tear down *everything* opened so far, not just the one that failed.
      // `reconnection: true` means the failing socket keeps retrying on its
      // own timer and the ones that already connected keep their heartbeat
      // timers, so a rejection here would otherwise leave the process alive
      // long after the error was printed.
      for (const socket of opened) {
        socket.removeAllListeners();
        socket.disconnect();
      }
      throw err;
    }
    return new SocketPool(pooled);
  }

  /** Round-robin one pooled socket, gated by its own rate + concurrency
   *  budget. `cpId` is omitted for daemon-level methods (`cp.create_many`,
   *  `cp.delete`, ...). */
  async rpc<T = unknown>(
    method: string,
    params: unknown,
    cpId?: string,
    timeoutMs: number = RPC_TIMEOUT_MS,
  ): Promise<T> {
    // One deadline for the whole call, started here rather than after
    // admission. A call can wait through several token-bucket refills and
    // semaphore permits before it is ever emitted, and timing only the ack
    // meant `RPC_TIMEOUT_MS` bounded the last stage alone — so step setup and
    // the "60 second" cleanup budget could both run far past the number they
    // document, and a documented bound is the contract.
    const deadline = Date.now() + Math.max(1, timeoutMs);
    const p = this.pick();
    await p.bucket.take();
    if (Date.now() >= deadline) {
      throw new RpcFailedError(
        "timeout",
        `${method} timed out waiting for a rate-limit slot`,
      );
    }
    const release = await p.sem.acquire();
    try {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new RpcFailedError(
          "timeout",
          `${method} timed out waiting for an in-flight slot`,
        );
      }
      // Socket.IO **buffers** an emit issued on a disconnected socket and
      // flushes it on reconnect, and our own timer cannot cancel a buffered
      // packet or its ack callback. A timed-out RPC could therefore execute
      // afterwards — a stale `start_transaction` or `stop_transaction`
      // arriving long after the caller handled it as failed, corrupting the
      // cadence and able to confirm a later cycle's waiter. Nothing is emitted
      // on a socket that is not connected: `pick()` prefers a connected one,
      // and if none is connected the call fails here rather than being queued
      // for an unknowable future.
      if (!p.socket.connected) {
        throw new RpcFailedError(
          "disconnected",
          `${method} not sent: no control-plane socket is connected`,
        );
      }
      return await new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          settled = true;
          reject(new RpcFailedError("timeout", `${method} timed out`));
        }, remainingMs);
        p.socket.emit(
          "rpc",
          { cpId, method, params },
          (
            ack:
              | { ok: true; result: T }
              | { ok: false; error: { code: string; message: string } },
          ) => {
            // A late ack for a call already rejected is dropped rather than
            // settling a promise nobody is waiting on any more.
            if (settled) return;
            clearTimeout(timer);
            if (ack.ok) resolve(ack.result);
            else reject(new RpcFailedError(ack.error.code, ack.error.message));
          },
        );
      });
    } finally {
      release();
    }
  }

  /** Round-robin, but skipping sockets that are not connected — a call is
   *  rerouted to a live socket rather than buffered on a dead one. Falls back
   *  to the plain round-robin pick when none is connected, so the caller gets
   *  the explicit `disconnected` failure above. */
  private pick(): PooledSocket {
    for (let i = 0; i < this.pooled.length; i++) {
      const candidate = this.pooled[this.rr++ % this.pooled.length]!;
      if (candidate.socket.connected) return candidate;
    }
    return this.pooled[this.rr++ % this.pooled.length]!;
  }

  /** Whether any pooled socket is currently connected.
   *
   *  socket.io *buffers* an `emit` issued while disconnected rather than
   *  failing it, so an RPC against a dead daemon does not error — it sits in
   *  the buffer until its timeout fires. Cleanup checks this first so a run
   *  whose daemon went away skips the delete sweep outright instead of
   *  spending its whole budget discovering that, one timeout at a time. */
  anyConnected(): boolean {
    return this.pooled.some((p) => p.socket.connected);
  }

  async closeAll(): Promise<void> {
    for (const p of this.pooled) p.socket.disconnect();
  }
}

/** Waits for a charge point's transaction to *actually* start.
 *
 *  The control-plane `start_transaction` ack says only that the daemon
 *  accepted the call: `CLIChargePointService.startTransaction` does not await
 *  `ChargePoint.startTransaction`, and with `AuthorizeBeforeLocalStart`
 *  (default **true**) that promise is still waiting on `Authorize.conf` when
 *  the ack lands. Timing the hold from the ack therefore made the generated
 *  load a function of CSMS latency — the variable this benchmark exists to
 *  measure. A slow enough authorization made the stop a no-op and left the
 *  transaction active into later cycles.
 *
 *  One dedicated socket, outside the RPC pool so its traffic spends none of
 *  the pool's rate budget, subscribed to the `"*"` scope. `reconnection` is
 *  off on purpose: room membership is per-connection server-side, and
 *  re-subscribing once the fleet is past 1000 charge points would fail
 *  `subscribeResultSchema`'s `ARRAY_1000` cap on the snapshot it returns. The
 *  subscribe therefore happens once, before the first charge point exists. */
class TransactionWatcher {
  /** The invariants — arm/confirm, and what a lost stream does to a run — live
   *  in `lib.ts` so they can be unit-tested; this class is the socket. */
  private readonly starts = new TransactionStarts();

  private constructor(private readonly socket: Socket) {}

  static async open(
    daemonUrl: string,
    auth: { username: string; password: string } | null,
  ): Promise<TransactionWatcher> {
    const socket = io(daemonUrl, {
      path: "/socket.io/",
      auth: auth ?? undefined,
      reconnection: false,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("event socket did not connect within 10s")),
          10_000,
        );
        socket.once("connect", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once("connect_error", (err: Error) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("events.subscribe timed out")),
          10_000,
        );
        socket.emit(
          "events.subscribe",
          { scope: "*" },
          (ack: { ok: boolean; error?: { message: string } } | undefined) => {
            clearTimeout(timer);
            if (ack && ack.ok === false) {
              reject(
                new Error(ack.error?.message ?? "events.subscribe failed"),
              );
            } else resolve();
          },
        );
      });
    } catch (err) {
      socket.removeAllListeners();
      socket.disconnect();
      throw err;
    }
    const watcher = new TransactionWatcher(socket);
    socket.on("event", (envelope: unknown) => watcher.onEvent(envelope));
    // `reconnection` is off, so a drop is terminal: room membership is
    // per-connection server-side and a re-subscribe past 1000 charge points
    // would fail the ack's `ARRAY_1000` snapshot anyway. Carrying on would
    // have meant every later cycle burning a full hold on a confirmation that
    // can never arrive — doubling transaction occupancy and collapsing the
    // rest period — so the run aborts instead of printing rows whose load is
    // no longer the load the row claims.
    socket.on("disconnect", () => {
      watcher.starts.lose(
        "the event socket dropped, so transaction starts can no longer be " +
          "confirmed and the remaining rows would not carry the configured " +
          "load. No table was printed. Re-run against a daemon that stays up.",
      );
    });
    return watcher;
  }

  /** The run's abort signal: `promise`, rejecting with a `BenchAbortError` the
   *  moment the event stream is lost. Long waits are raced against it. */
  lost<T>(promise: Promise<T>): Promise<T> {
    return this.starts.lost(promise);
  }

  /** Arm a waiter for `cpId` **before** its `start_transaction` is emitted.
   *  The event arrives on this socket while the ack arrives on a pool socket,
   *  and nothing orders the two — arming after the ack would drop the event
   *  of every fast CSMS and skip every stop. Resolves `false` on timeout. */
  arm(
    cpId: string,
    timeoutMs: number,
    awaitAssignedId: boolean,
  ): Promise<TransactionStartOutcome> {
    return this.starts.arm(cpId, timeoutMs, awaitAssignedId);
  }

  private onEvent(envelope: unknown): void {
    const env = envelope as
      | {
          kind?: string;
          cpId?: string;
          evt?: { event?: string; data?: { transactionId?: number } };
        }
      | undefined;
    if (env?.kind !== "cp" || env.evt?.event !== "transaction_started") return;
    const cpId = env.cpId;
    const transactionId = env.evt.data?.transactionId;
    if (cpId === undefined || typeof transactionId !== "number") return;
    // Both emissions are forwarded, and `TransactionStarts` decides which one
    // settles the cycle: 1.6 emits `transaction_started` once locally with the
    // placeholder id 0 and again when `StartTransaction.conf` brings the real
    // one. Dropping the second here — as this did — kept a straggling conf
    // from confirming a newer cycle, but also threw away the assigned id, so a
    // conf slower than the hold left the stop sending id 0.
    this.starts.confirm(cpId, transactionId);
  }

  close(): void {
    // Before `disconnect()`, so the handler above sees a tracker that is
    // already closed and does not turn a deliberate teardown into an abort.
    this.starts.close();
    this.socket.removeAllListeners();
    this.socket.disconnect();
  }
}

async function fetchMetrics(
  daemonUrl: string,
  auth: { username: string; password: string } | null,
): Promise<Sample[]> {
  const headers: Record<string, string> = {};
  if (auth) {
    headers.Authorization =
      "Basic " +
      Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
  }
  const res = await fetchWithDeadline(
    `${daemonUrl}/metrics`,
    { headers },
    "GET /metrics",
  );
  if (!res.ok) {
    throw new Error(`GET /metrics -> ${res.status} ${res.statusText}`);
  }
  return parseExposition(await res.text());
}

interface Preflight {
  readonly daemonVersion: string;
  /** The fleet gauge before this run created anything. Every later settle
   *  target and connected count is relative to it, so a run with
   *  `--allow-existing` still reports its own fleet rather than the daemon's. */
  readonly baseline: FleetGauge;
}

async function preflight(
  opts: BenchOptions,
  runId: string,
): Promise<Preflight> {
  const headers: Record<string, string> = {};
  if (opts.daemonBasicAuth) {
    headers.Authorization =
      "Basic " +
      Buffer.from(
        `${opts.daemonBasicAuth.username}:${opts.daemonBasicAuth.password}`,
      ).toString("base64");
  }
  const healthRes = await fetchWithDeadline(
    `${opts.daemonUrl}${opts.healthPath}`,
    { headers },
    "the daemon health check",
  );
  if (!healthRes.ok) {
    throw new Error(
      `daemon health check failed: ${healthRes.status} ${healthRes.statusText}`,
    );
  }
  const health = (await healthRes.json()) as { ok?: boolean; version?: string };
  if (!health.ok) {
    throw new Error(`daemon health check returned ok:false`);
  }

  const metricsRes = await fetchWithDeadline(
    `${opts.daemonUrl}/metrics`,
    { headers },
    "GET /metrics",
  );
  if (metricsRes.status === 404) {
    throw new Error(
      "GET /metrics -> 404. Start the daemon with --metrics " +
        "(see docs/entities/daemon.md#metrics).",
    );
  }
  if (!metricsRes.ok) {
    throw new Error(
      `GET /metrics -> ${metricsRes.status} ${metricsRes.statusText}`,
    );
  }

  if (opts.outFile) {
    const dir = dirname(resolve(opts.outFile));
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new Error(`--out ${opts.outFile}: directory ${dir} does not exist`);
    }
  }

  const samples = parseExposition(await metricsRes.text());
  const preExisting = assertDaemonEmpty(samples, opts.allowExisting);
  if (preExisting > 0) {
    process.stderr.write(
      `[bench] WARNING: --allow-existing: ${preExisting} pre-existing charge ` +
        `point(s) are on this daemon. Their OCPP traffic is inside every ` +
        `measurement window below; N counts only this run's fleet. They cannot ` +
        `collide with it — this run's charge points are named ` +
        `${BENCH_ID_ROOT}-${runId}-* — and teardown deletes only that fleet. If any of ` +
        `them are ${BENCH_ID_ROOT}-* they are an earlier run's leftovers, and deleting ` +
        `them by hand is what the preflight is asking for.\n`,
    );
  }
  return {
    daemonVersion: health.version ?? "unknown",
    baseline: fleetGauge(samples),
  };
}

/** The hardware block, attributed to whoever it actually describes. `os.*`
 *  and `Bun.version` describe this process, which is the machine under test
 *  only when the daemon is local — see {@link machineReport}. */
function machineInfo(daemonUrl: string, daemonVersion: string): string {
  const cpus = os.cpus();
  return machineReport({
    daemonUrl,
    cpuModel: cpus[0]?.model ?? "unknown CPU",
    cores: cpus.length,
    memGb: (os.totalmem() / 1024 ** 3).toFixed(1),
    platform: os.platform(),
    arch: os.arch(),
    bunVersion: Bun.version,
    daemonVersion,
  });
}

/** Where the next generated charge point id starts.
 *
 *  Tracked separately from the live fleet size on purpose: `cp.create_many`
 *  succeeds partially, so "how many charge points exist" and "which ids have
 *  been handed out" diverge the moment one creation fails. Indexing the id
 *  pattern off the live count made the next step restart inside the previous
 *  step's id range, where every id already existed — so the failure cascaded
 *  and every later step's nominal `N` sat below target. */
interface IdCursor {
  nextIndex: number;
}

/** Create `count` more CPs, chunked at `CP_CREATE_MANY_MAX` per call. Returns
 *  every id `cp.create_many` reported created; failures are logged and
 *  excluded rather than retried, matching `cp.create_many`'s own
 *  partial-success contract.
 *
 *  Every id a chunk *offers* enters `cleanupIds` before the RPC is awaited,
 *  and the ids the ack **names as failures leave it again**. See
 *  {@link cleanupIdsAfterBatch} for why those two rules are not in tension:
 *  the first covers the indeterminate case (an RPC deadline does not cancel
 *  the server-side work, so the daemon may hold charge points whose ids never
 *  reached this process), while the second covers the determinate one — a
 *  reported failure is positive evidence the charge point is not ours, and
 *  under `--allow-existing` an id collision with someone else's charge point
 *  is reported exactly that way. Deleting on that evidence destroyed fleets
 *  this run never created. */
async function growFleet(
  pool: SocketPool,
  opts: BenchOptions,
  runId: string,
  cursor: IdCursor,
  count: number,
  cleanupIds: Set<string>,
  abort: { requested: boolean },
): Promise<string[]> {
  const created: string[] = [];
  let remaining = count;
  while (remaining > 0) {
    // Checked between batches, so an interrupt that lands mid-step stops
    // offering new ids rather than racing the cleanup snapshot.
    if (abort.requested) break;
    const chunk = Math.min(remaining, CP_CREATE_MANY_MAX);
    // Spend the ids *before* awaiting. Whether the call succeeds, partly
    // succeeds or rejects outright, this index range has been offered to the
    // daemon and must never be offered again.
    const index = cursor.nextIndex;
    cursor.nextIndex += chunk;
    const offered: string[] = [];
    for (let i = 0; i < chunk; i++) offered.push(benchCpId(runId, index + i));
    // Provisional, and deliberately added before the await: if this call
    // throws, the ids stay listed, because an RPC deadline does not tell the
    // daemon to stop and it may hold every one of them.
    for (const id of offered) cleanupIds.add(id);
    const result = await pool.rpc<{
      created: string[];
      failed: { cpId: string; reason: string }[];
    }>("cp.create_many", {
      wsUrl: opts.csmsUrl,
      // Passed explicitly: `cp.create_many` defaults to OCPP-1.6J, so against
      // a 2.x-only CSMS every handshake was rejected and the run reported an
      // unsettled fleet with no latency data and no reason why.
      ocppVersion: opts.ocppVersion,
      connectors: 1,
      vendor: "ocpp-cp-simulator",
      model: "fleet-bench",
      autoConnect: true,
      count: chunk,
      idPattern: benchIdPattern(runId),
      startIndex: index,
    });
    // Determinate. Re-derive this batch's cleanup membership from the ack:
    // failures drop out, unpredicted creations come in.
    for (const id of offered) cleanupIds.delete(id);
    for (const id of cleanupIdsAfterBatch(offered, result)) cleanupIds.add(id);

    // The daemon expands `idPattern` itself, so this is the check that keeps
    // the local copy honest: an id it created that this process did not
    // predict is an id cleanup would miss.
    const unpredicted = unpredictedCreatedIds(offered, result.created);
    if (unpredicted.length > 0) {
      process.stderr.write(
        `[bench] WARNING: cp.create_many returned ${unpredicted.length} id(s) this ` +
          `script did not predict (e.g. ${unpredicted[0]}). benchCpId() has drifted ` +
          `from expandIdPattern() in src/protocol/methods.ts.\n`,
      );
    }
    created.push(...result.created);
    for (const f of result.failed) {
      process.stderr.write(
        `[bench] create failed for ${f.cpId} (not deleted at teardown: this run ` +
          `did not create it): ${f.reason}${createFailureHint(f.reason)}\n`,
      );
    }
    remaining -= chunk;
  }
  return created;
}

/** Poll the `ocppcp_charge_points` gauge until at least `targetConnected`
 *  charge points report a state other than "Unavailable" (the value
 *  `ChargePoint.status` takes on disconnect / before boot), or the timeout
 *  elapses.
 *
 *  The gauge rather than `cp.list`: `cp.list`'s *result* schema is
 *  `ARRAY_1000` (`src/protocol/methods.ts`), so past 1000 charge points the
 *  response fails validation and the RPC answers `internal` — which made the
 *  advertised 2000-CP sweep abort at the step that crossed the cap. The gauge
 *  is one bounded number whatever the fleet size. */
async function waitForSettle(
  opts: BenchOptions,
  targetConnected: number,
  timeoutSec: number,
): Promise<{ connected: number; notSettled: number }> {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const samples = await fetchMetrics(opts.daemonUrl, opts.daemonBasicAuth);
    const connected = fleetGauge(samples).connected;
    if (connected >= targetConnected || Date.now() >= deadline) {
      return {
        connected,
        notSettled: Math.max(0, targetConnected - connected),
      };
    }
    await sleep(500);
  }
}

/** Arm each given CP's heartbeat at the configured cadence and, in active
 *  mode, kick off a staggered start/stop transaction cycle that runs until
 *  `stop()` is called. Called once per step with only that step's newly
 *  created CPs — earlier steps' CPs keep running under their own handle. */
function armLoad(
  pool: SocketPool,
  cpIds: readonly string[],
  startIndex: number,
  epochMs: number,
  runId: string,
  opts: BenchOptions,
  watcher: TransactionWatcher | null,
): {
  stop: () => void;
  ready: Promise<void>;
  unconfirmedStarts: () => number;
  lateHolds: () => number;
  retired: () => number;
  /** Charge points believed to have a transaction open right now. Teardown
   *  closes these before deleting anything — see {@link closeOpenTransactions}. */
  openTransactions: () => string[];
  /** Wait, up to `budgetMs`, for cycles already in flight when `stop()` landed
   *  to finish what they were doing. Without it a start still travelling to
   *  the CSMS lands *after* teardown's closing stop, and that transaction is
   *  left open on a charge point that is about to be deleted. */
  settle: (budgetMs: number) => Promise<void>;
} {
  let stopped = false;
  let unconfirmedStarts = 0;
  let lateHolds = 0;
  let retired = 0;
  /** Charge points whose transaction this handle has started and not yet
   *  stopped. Populated before the start RPC rather than after it: a start
   *  whose ack never came may still have opened a transaction at the CSMS, and
   *  a redundant stop is a no-op while a missing one is a dangling session. */
  const openTransactions = new Set<string>();
  /** Global index per charge point, for its idTag. */
  const idTagOf = new Map<string, string>(
    cpIds.map((cpId, i) => [cpId, benchIdTag(runId, startIndex + i)]),
  );
  /** Cycle bodies currently running, so teardown can wait for them. */
  const inFlight = new Set<Promise<unknown>>();
  function track(work: Promise<unknown>): void {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  }
  // Only OCPP 1.6 assigns a numeric transaction id — 2.x never sets one, so
  // waiting for it there would time out every cycle and stretch the cadence
  // for an id that is not coming.
  const awaitAssignedId = opts.ocppVersion === OCPP_1_6;
  const confirmTimeoutMs = awaitAssignedId
    ? ASSIGNED_ID_TIMEOUT_MS
    : START_CONFIRM_TIMEOUT_MS;
  // Only *live* timers, and each one removes itself as it fires. A plain
  // array that every cycle appended to grew by two handles per transaction
  // per charge point and never shrank, so a long 2000-CP run retained
  // millions of dead handles for a `stop()` that would only ever clear them.
  const live = new Set<ReturnType<typeof setTimeout>>();

  /** `setTimeout` whose handle leaves {@link live} the moment it fires, and
   *  which does not run its body at all once `stop()` has been called. */
  function schedule(fn: () => void, ms: number): void {
    if (stopped) return;
    const timer = setTimeout(() => {
      live.delete(timer);
      if (stopped) return;
      fn();
    }, ms);
    live.add(timer);
  }

  const holdMs = holdSec(opts.txIntervalSec) * 1000;
  const periodMs = cyclePeriodSec(opts.txIntervalSec) * 1000;

  const ready = (async () => {
    for (const cpId of cpIds) {
      if (stopped) return;
      try {
        await pool.rpc(
          "start_heartbeat",
          { interval: opts.heartbeatIntervalSec },
          cpId,
        );
      } catch (err) {
        process.stderr.write(
          `[bench] start_heartbeat failed for ${cpId}: ${String(err)}\n`,
        );
      }
    }
    // Re-checked after the arming loop's awaits, the way `AutoTrafficRunner`
    // re-checks after every await (#300): `stop()` landing mid-loop would
    // otherwise be followed by one fresh timer per charge point.
    if (stopped) return;
    if (opts.txIntervalSec <= 0) return;
    // Phased off each charge point's **global** index, never its index within
    // this cohort. The fleet grows in place, so a per-cohort stagger restarted
    // the phase at 0 for every step — with `--counts 1,2,3` all three landed
    // in nearly the same phase, a burst rather than a stagger, and a knee that
    // would belong to this script rather than to the daemon. Deterministic, so
    // two runs with the same flags issue the same traffic (see
    // `staggerOffsetsMs`).
    const offsets = staggerOffsetsMs(
      startIndex,
      cpIds.length,
      opts.txIntervalSec,
    );
    // Measured from the run-wide epoch, not from whenever this cohort finished
    // arming. Global indices fix *which* fraction of the period a charge point
    // gets; they say nothing about what it is measured from, and creation,
    // settling and heartbeat arming all take variable time — so without this
    // every cohort was rotated by an arbitrary amount and two well-separated
    // indices could still collide in wall-clock phase. The offsets are read
    // once, after the arming awaits, so every charge point in the cohort is
    // rebased against the same instant.
    const elapsedMs = Date.now() - epochMs;
    cpIds.forEach((cpId, i) => {
      schedule(
        () => track(cycle(cpId)),
        firstCycleDelayMs(offsets[i]!, elapsedMs, periodMs),
      );
    });
  })();

  async function cycle(cpId: string): Promise<void> {
    if (stopped) return;
    const cycleStartedAtMs = Date.now();
    // Armed before the RPC is emitted, never after its ack: the
    // `transaction_started` event arrives on the watcher's socket while the
    // ack arrives on a pool socket, and nothing orders those two.
    const started = watcher
      ? watcher.arm(cpId, confirmTimeoutMs, awaitAssignedId)
      : Promise.resolve<TransactionStartOutcome>({
          started: true,
          transactionId: null,
          localStartAtMs: null,
        });
    // Marked open before the call, not after its ack: a start whose ack never
    // arrived may still have opened a transaction at the CSMS.
    openTransactions.add(cpId);
    try {
      await pool.rpc(
        "start_transaction",
        // A distinct tag per charge point. Sharing one made a CSMS that
        // enforces per-idTag concurrency answer ConcurrentTx to every
        // concurrent start after the first, so the run applied a fraction of
        // the load it reported.
        { connector: 1, tagId: idTagOf.get(cpId) },
        cpId,
      );
    } catch (err) {
      process.stderr.write(
        `[bench] start_transaction failed for ${cpId}: ${String(err)}\n`,
      );
    }
    // Hold from the moment the transaction *started*, not from the moment the
    // daemon acknowledged the call. The ack returns while
    // `ChargePoint.startTransaction` is still awaiting `Authorize.conf`, so
    // timing the hold from it shortened every hold by the authorization
    // latency and made the stop a no-op that left the transaction running into
    // later cycles — the load changing as a function of the very latency being
    // measured.
    //
    // The wait is bounded by the *authorization* timeout, never by the hold.
    // At `--tx-interval 2` the hold is 1s while authorization may legitimately
    // take 10s, so a hold-length wait declared the start dead while it was
    // still pending, stopped a transaction that did not exist, and started the
    // next cycle straight into the arrival of the old one. Because
    // `authorizeAndWait` never rejects — it resolves "Accepted" on timeout —
    // a start still unconfirmed after this bound was genuinely denied, so this
    // is waiting for a definitive answer rather than giving up early. No
    // second cycle is scheduled until this one has been answered, held and
    // stopped.
    const outcome = await started;
    if (!outcome.started) unconfirmedStarts++;

    // Started, but the CSMS never assigned an id inside the bound. Its
    // `StartTransaction` has been abandoned by the daemon's own per-CALL
    // watchdog, so the conf may still arrive — and if it did, it would land
    // during a *later* cycle, after that cycle's own placeholder emission, and
    // be accepted as that cycle's id. The simulator would then apply a stale
    // id to the current connector transaction and both the next stop and the
    // cadence would use the wrong one.
    //
    // Correlating by generation is not possible: the event carries only the
    // charge point id and the transaction id, so a stale conf is
    // indistinguishable by content from a fresh one. So this charge point
    // stops cycling instead. Reaching this at all means the CSMS took longer
    // than the authorization wait plus a full CALL watchdog to answer, which
    // is past the ceiling the sweep is looking for; continuing would keep
    // generating load whose accounting cannot be trusted. The retirement is
    // reported per step, so the row shows the fleet's load falling rather than
    // hiding it.
    //
    // This is also what makes the stale-conf hazard impossible rather than
    // merely unlikely: a stale id can only exist after a confirmation timeout,
    // and after one this charge point is never armed again.
    const retiring =
      awaitAssignedId && outcome.started && !outcome.transactionId;
    if (retiring) {
      retired++;
      process.stderr.write(
        `[bench] ${cpId}: transaction started but no id was assigned within ` +
          `${confirmTimeoutMs / 1000}s. Stopping it and retiring this charge ` +
          `point from the transaction cycle — a conf arriving now would be ` +
          `taken for a later cycle's.\n`,
      );
    }

    // The awaits above can span a `stop()`; without this check the callback
    // installs a timer after cleanup already cleared the set, keeping the
    // process alive for up to half a --tx-interval.
    if (stopped) return;

    // The hold runs from when the transaction actually began, never from when
    // its id was confirmed. Waiting for the assigned id and *then* starting
    // the timer added the whole `StartTransaction.conf` latency to every
    // transaction's on-time — near the knee, seconds on top of a configured
    // one-second hold — so the duty cycle silently stopped matching the
    // configuration.
    const heldForMs =
      outcome.localStartAtMs === null ? 0 : Date.now() - outcome.localStartAtMs;
    const holdRemainingMs = holdMs - heldForMs;
    if (holdRemainingMs <= 0 && !retiring) {
      // The confirmation alone outlasted the hold, so this transaction has
      // already been on longer than configured. Stop now and record it; the
      // alternative is to hold anyway and report a duty cycle the run did not
      // have.
      lateHolds++;
    }

    const stopAndContinue = async (): Promise<void> => {
      // Sent even when the start was never confirmed: a start that was only
      // slow still has to be cleared, or the connector stays occupied and
      // every later cycle for this charge point is refused as a duplicate.
      try {
        await pool.rpc("stop_transaction", { connector: 1 }, cpId);
        openTransactions.delete(cpId);
      } catch (err) {
        // Left in `openTransactions` on purpose: a stop that failed is a
        // transaction still open, and teardown must try again.
        process.stderr.write(
          `[bench] stop_transaction failed for ${cpId}: ${String(err)}\n`,
        );
      }
      if (stopped || retiring) return;
      // Next start one full period after this one *started*, not one hold
      // after this one stopped: the cycle period stays exactly --tx-interval
      // while the CSMS keeps up, and stretches only when it genuinely cannot.
      schedule(
        () => track(cycle(cpId)),
        Math.max(0, cycleStartedAtMs + periodMs - Date.now()),
      );
    };

    if (holdRemainingMs <= 0) {
      track(stopAndContinue());
      return;
    }
    schedule(() => track(stopAndContinue()), holdRemainingMs);
  }

  return {
    ready,
    unconfirmedStarts: () => unconfirmedStarts,
    lateHolds: () => lateHolds,
    retired: () => retired,
    openTransactions: () => [...openTransactions],
    settle: async (budgetMs: number): Promise<void> => {
      // Bounded: a cycle blocked on a confirmation that will never arrive must
      // not hold teardown open. Anything still running past the budget is
      // reported by `closeOpenTransactions` as a transaction that may be left.
      await Promise.race([
        (async () => {
          // Re-read the set each pass: finishing one cycle can start none, but
          // a cycle settling may still be mid-await when the first pass reads.
          for (let pass = 0; pass < 3 && inFlight.size > 0; pass++) {
            await Promise.allSettled([...inFlight]);
          }
        })(),
        sleep(budgetMs),
      ]);
    },
    stop: () => {
      stopped = true;
      for (const t of live) clearTimeout(t);
      live.clear();
    },
  };
}

/** Overall budget for closing transactions still open at teardown. Bounded
 *  like the delete sweep and for the same reason: a daemon that has stopped
 *  answering must not turn teardown into an unbounded wait. */
const CLOSE_TX_BUDGET_MS = 30_000;

/** How long teardown waits for cycles already in flight to finish before it
 *  starts closing transactions. Short on purpose: it only has to cover a start
 *  already travelling to the CSMS, not a confirmation that may never come. */
const SETTLE_CYCLES_BUDGET_MS = 5_000;

/**
 * Close every transaction this run still has open, before anything is deleted.
 *
 * `stop()` only cancels timers. On the active axis roughly half the fleet is
 * inside its hold at any moment, and those pending callbacks are exactly the
 * ones that would have sent `stop_transaction` — so clearing them and then
 * deleting the charge points left the **CSMS** holding transactions that never
 * ended, contaminating every later run against it.
 *
 * The two invariants written down last round both concern the daemon: record
 * ids before creation, and delete only what this run created. Neither covers
 * this, because the resource is on a third-party system whose state the run
 * cannot enumerate — there is no CSMS equivalent of `cp.list` to reconcile
 * against. So it can only be satisfied by construction: close what you opened,
 * before the charge point that could close it is gone.
 */
async function closeOpenTransactions(
  pool: SocketPool,
  cpIds: readonly string[],
): Promise<void> {
  if (cpIds.length === 0) return;
  if (!pool.anyConnected()) {
    process.stderr.write(
      `[bench] cannot close ${cpIds.length} open transaction(s): no ` +
        `control-plane socket is connected. The CSMS may be left holding ` +
        `them.\n`,
    );
    return;
  }
  process.stderr.write(
    `[bench] closing ${cpIds.length} open transaction(s) before deleting\n`,
  );
  const deadline = Date.now() + CLOSE_TX_BUDGET_MS;
  let next = 0;
  let closed = 0;
  let unresponsive = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (unresponsive) return;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return;
      const i = next++;
      if (i >= cpIds.length) return;
      try {
        await pool.rpc(
          "stop_transaction",
          { connector: 1 },
          cpIds[i]!,
          remainingMs,
        );
        closed++;
      } catch (err) {
        if (err instanceof RpcFailedError && err.code === "timeout") {
          unresponsive = true;
        }
        // Anything else: the connector may simply have had no transaction,
        // which is the outcome wanted.
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CLEANUP_CONCURRENCY, cpIds.length) }, worker),
  );
  const left = cpIds.length - closed;
  if (left > 0) {
    process.stderr.write(
      `[bench] ${left} transaction(s) could not be closed` +
        `${unresponsive ? " (the daemon stopped answering)" : ""}; the CSMS ` +
        `may be left holding them.\n`,
    );
  }
}

/** Best-effort teardown of everything this run created, bounded by
 *  {@link CLEANUP_BUDGET_MS} and run {@link CLEANUP_CONCURRENCY}-wide.
 *
 *  Bounded because it is best-effort: deleting sequentially with the full
 *  35s RPC timeout each meant a daemon that had died turned teardown of a
 *  2000-CP fleet into hours of blocked failure handling and an unresponsive
 *  Ctrl-C. Anything left is named in the output, because the next run's
 *  preflight will refuse this daemon over it (`assertDaemonEmpty`). */
async function deleteFleet(
  pool: SocketPool,
  runId: string,
  cpIds: readonly string[],
): Promise<void> {
  if (cpIds.length === 0) return;
  if (!pool.anyConnected()) {
    process.stderr.write(
      `[bench] skipping cleanup: no control-plane socket is connected, so ` +
        `${cpIds.length} charge point(s) named ${BENCH_ID_ROOT}-${runId}-* remain on ` +
        `the daemon. Restart it, or delete them before the next run — the ` +
        `preflight refuses a daemon that already holds charge points.\n`,
    );
    return;
  }
  process.stderr.write(
    `[bench] cleaning up ${cpIds.length} charge point(s) (up to ${CLEANUP_BUDGET_MS / 1000}s)\n`,
  );
  const deadline = Date.now() + CLEANUP_BUDGET_MS;
  let next = 0;
  let deleted = 0;
  // One timeout means the daemon has stopped answering; the remaining ids
  // would each spend the rest of the budget learning the same thing.
  let daemonUnresponsive = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (daemonUnresponsive) return;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return;
      const i = next++;
      if (i >= cpIds.length) return;
      try {
        await pool.rpc(
          "cp.delete",
          { cpId: cpIds[i]! },
          undefined,
          remainingMs,
        );
        deleted++;
      } catch (err) {
        if (err instanceof RpcFailedError && err.code === "timeout") {
          daemonUnresponsive = true;
        } else if (err instanceof RpcFailedError && err.code === "not_found") {
          // Already gone — the outcome cleanup wanted, so it counts as done
          // rather than inflating the "still registered" tally below.
          deleted++;
        }
        // Anything else is best-effort and simply left behind.
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CLEANUP_CONCURRENCY, cpIds.length) }, worker),
  );
  const left = cpIds.length - deleted;
  if (left > 0) {
    process.stderr.write(
      `[bench] cleanup gave up with ${left} charge point(s) still registered ` +
        `(they are the ones named ${BENCH_ID_ROOT}-${runId}-*)` +
        `${daemonUnresponsive ? " (the daemon stopped answering)" : ""}. The next ` +
        `run's preflight will refuse this daemon until they are gone.\n`,
    );
  }
}

async function main(): Promise<void> {
  let opts: BenchOptions;
  try {
    opts = validateOptions(parseArgv(process.argv.slice(2)));
  } catch (err) {
    if (err instanceof BenchValidationError) {
      process.stderr.write(`Error: ${err.message}\n\n`);
      printUsage();
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  // Fixed once per process, before anything is created. Every charge point
  // this run makes is named under it, so a pre-existing charge point cannot
  // collide with an id this run offers — which is what makes "the benchmark
  // deleted something it did not create" unrepresentable rather than merely
  // guarded against.
  const runId = newRunId(Date.now());
  process.stderr.write(
    `[bench] preflight: health + /metrics on ${redactUrlUserinfo(opts.daemonUrl)}\n`,
  );
  process.stderr.write(
    `[bench] run id ${runId}: charge points are created as ${benchIdPattern(runId)}\n`,
  );
  const { daemonVersion, baseline } = await preflight(opts, runId);

  process.stderr.write(machineInfo(opts.daemonUrl, daemonVersion) + "\n");
  process.stderr.write(
    `[bench] mode: ${opts.txIntervalSec > 0 ? `active (tx every ~${opts.txIntervalSec}s)` : "idle (heartbeat only)"}, heartbeat every ${opts.heartbeatIntervalSec}s\n`,
  );
  process.stderr.write(
    `[bench] OCPP version: ${opts.ocppVersion}, warmup ${opts.warmupSec}s per step\n`,
  );
  if (opts.ocppVersion !== OCPP_1_6) {
    process.stderr.write(
      `[bench] NOTE: the 30s per-CALL watchdog is implemented only in the ` +
        `OCPP-1.6J message handler, so on ${opts.ocppVersion} an abandoned CALL is ` +
        `never counted at all and the "timeouts" column reads n/a rather than 0. ` +
        `Use "late>30s", errors and reconnects as the knee signals there.\n`,
    );
  }
  if (opts.txIntervalSec > 0) {
    const maxN = opts.counts.at(-1)!;
    process.stderr.write(
      `[bench] transaction load at N=${maxN}: ` +
        `${requiredRpcPerSec(maxN, opts.txIntervalSec).toFixed(0)} RPC/s of a ` +
        `${sustainableRpcPerSec(socketPoolSize(maxN, opts.txIntervalSec)).toFixed(0)} RPC/s ` +
        `pool budget (2 calls per CP per ${cyclePeriodSec(opts.txIntervalSec)}s cycle)\n`,
    );
  }
  const recommendedWarmup = recommendedWarmupSec(opts.txIntervalSec);
  if (opts.warmupSec < recommendedWarmup) {
    process.stderr.write(
      `[bench] NOTE: --warmup ${opts.warmupSec}s is under the ${recommendedWarmup}s this run needs ` +
        `(${opts.txIntervalSec}s stagger ramp + the ${CALL_WATCHDOG_SEC}s CALL watchdog), so a step's ` +
        `"timeouts" delta can still contain calls issued before that step reached N.\n`,
    );
  }

  const maxN = opts.counts.at(-1)!;
  // Sized by the transaction rate as well as the fleet: 200 charge points fit
  // on one socket, but at `--tx-interval 2` they demand 200 RPC/s and one
  // socket allows 64, so a fleet-only pool applied a third of the configured
  // load and reported the latency of that smaller load. `validateOptions` has
  // already refused anything the full pool cannot sustain.
  const socketCount = socketPoolSize(maxN, opts.txIntervalSec);
  process.stderr.write(
    `[bench] opening ${socketCount} control-plane socket(s)\n`,
  );
  const pool = await SocketPool.connect(
    opts.daemonUrl,
    socketCount,
    opts.daemonBasicAuth,
  );

  // Opened inside the cleanup scope below, never before it. The pooled sockets
  // set `reconnection: true`, so anything that throws between their connect and
  // the `try`'s `finally` leaves them open and retrying: the top-level catch
  // prints the error and the process never exits. Every await from here on is
  // therefore covered by `cleanup()`.
  let watcher: TransactionWatcher | null = null;

  const allCpIds: string[] = [];
  // A superset of `allCpIds`: every id offered to `cp.create_many`, including
  // those of a batch whose RPC never answered. Cleanup sweeps this, so an
  // indeterminate create cannot leave charge points behind for the next run's
  // preflight to trip over.
  const cleanupIds = new Set<string>();
  const results: StepResult[] = [];
  // One stop handle per step's `armLoad` call — steps only ever *add* CPs, so
  // each step arms just the CPs it created and earlier steps' handles keep
  // running rather than being torn down and re-armed every step (which would
  // clear in-flight transaction timers and re-issue start_transaction on
  // connectors already mid-session).
  const stopLoads: Array<() => void> = [];
  const loads: Array<{
    unconfirmedStarts: () => number;
    lateHolds: () => number;
    retired: () => number;
    openTransactions: () => string[];
    settle: (budgetMs: number) => Promise<void>;
  }> = [];

  // Runs once: the `finally` below and the SIGINT handler can both reach it,
  // and a second concurrent delete sweep would double the teardown budget for
  // charge points the first sweep is already deleting.
  // Set by the SIGINT handler, read by the sweep between steps and by
  // `growFleet` between batches. Creation must *stop* before cleanup reads the
  // id list, or the list is read too early — see below.
  const abort = { requested: false };
  // The abort *signal*, as opposed to the flag. The flag alone was only read
  // between steps and between create batches, so an interrupt during a
  // measurement or settle wait — up to an hour at the permitted maximum — held
  // every deletion until that wait finished on its own, and the only escape
  // was a second Ctrl-C, which explicitly leaks the fleet. Racing the long
  // waits against this lets the sweep unwind at once: the same shape
  // `untilLost` already uses for a dropped event socket.
  let signalAbort: () => void = () => {};
  const abortSignal = new Promise<never>((_resolve, reject) => {
    signalAbort = () =>
      reject(
        new BenchAbortError(
          "interrupted: stopping the sweep so the fleet can be deleted",
        ),
      );
  });
  // Nothing may be racing it at the instant it rejects, and an unobserved
  // rejection would be an unhandled-rejection crash carrying the wrong story.
  abortSignal.catch(() => undefined);
  /** Resolves when the sweep loop has unwound. Assigned as soon as the loop
   *  starts so the signal handler can await it. */
  let sweepSettled: Promise<unknown> = Promise.resolve();

  let cleanupStarted: Promise<void> | null = null;
  const cleanup = async (): Promise<void> => {
    cleanupStarted ??= (async () => {
      // Stop creating, then wait for creation to have stopped, and only then
      // snapshot the ids. A SIGINT landing while `growFleet` awaited one batch
      // of a multi-batch step used to snapshot `cleanupIds` immediately: the
      // outstanding batch then finished and later batches were offered and
      // created *after* the snapshot, so the handler exited having deleted
      // only the earlier ids and left BENCH-* charge points registered.
      abort.requested = true;
      signalAbort();
      for (const stop of stopLoads) stop();
      await sweepSettled.catch(() => undefined);
      // Let cycles already in flight finish first, so a start still on its way
      // to the CSMS is not overtaken by the stop meant to close it.
      await Promise.all(loads.map((l) => l.settle(SETTLE_CYCLES_BUDGET_MS)));
      // Then close what is open. `stop()` cancelled the timers that would have
      // sent these, and a deleted charge point can no longer end its session,
      // so without this the CSMS is left holding them.
      await closeOpenTransactions(
        pool,
        loads.flatMap((l) => l.openTransactions()),
      );
      watcher?.close();
      await deleteFleet(pool, runId, [...cleanupIds]);
      await pool.closeAll();
    })();
    return cleanupStarted;
  };
  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) {
      // A second Ctrl-C means the operator is no longer willing to wait for a
      // graceful teardown. Say what that costs rather than appearing to hang.
      process.stderr.write(
        `[bench] second interrupt: exiting now. Charge points named ` +
          `${BENCH_ID_ROOT}-${runId}-* may remain on the daemon.\n`,
      );
      process.exit(130);
    }
    interrupted = true;
    process.stderr.write(
      `[bench] interrupted: stopping creation and cleaning up. Ctrl-C again to ` +
        `exit immediately (which may leave charge points behind).\n`,
    );
    void cleanup().finally(() => process.exit(130));
  });

  try {
    // The sweep runs as a promise so `cleanup()` can await its unwinding
    // before reading the id list.
    const sweep = (async (): Promise<void> => {
      // Before the first charge point exists, on purpose: the `events.subscribe`
      // ack carries a snapshot of the whole fleet through an `ARRAY_1000`
      // schema, so subscribing once the sweep is past 1000 charge points would
      // fail. A failure here reaches the `finally` and closes the pool.
      if (opts.txIntervalSec > 0) {
        watcher = await TransactionWatcher.open(
          opts.daemonUrl,
          opts.daemonBasicAuth,
        );
      }
      // Every long wait below is raced against the event socket's loss, so a run
      // that can no longer confirm transaction starts stops and says why instead
      // of printing rows whose load is no longer the load they claim.
      // Every long wait is raced against both the event socket's loss and the
      // interrupt, so neither has to wait out a measurement window.
      const untilLost = <T>(p: Promise<T>): Promise<T> =>
        Promise.race([watcher ? watcher.lost(p) : p, abortSignal]);

      // One origin for every cohort's stagger, fixed before the first charge
      // point exists. See `firstCycleDelayMs`.
      const runEpochMs = Date.now();
      const cursor: IdCursor = { nextIndex: 1 };
      // Cumulative across steps, like the daemon's counters: each row reports
      // its own delta.
      let unconfirmedStartsBefore = 0;
      let lateHoldsBefore = 0;
      let retiredBefore = 0;
      for (const n of opts.counts) {
        if (abort.requested) return;
        const toCreate = n - allCpIds.length;
        process.stderr.write(
          `[bench] N=${n}: creating ${toCreate} more CP(s)\n`,
        );
        const created = await untilLost(
          growFleet(pool, opts, runId, cursor, toCreate, cleanupIds, abort),
        );
        allCpIds.push(...created);
        const notCreated = n - allCpIds.length;
        if (notCreated > 0) {
          process.stderr.write(
            `[bench] N=${n}: only ${allCpIds.length} charge point(s) exist; the row ` +
              `below is labelled with that, not with ${n}\n`,
          );
        }

        // Relative to the preflight baseline, so `--allow-existing` measures
        // this run's fleet settling rather than the daemon's whole population.
        const { connected, notSettled } = await untilLost(
          waitForSettle(
            opts,
            baseline.connected + allCpIds.length,
            opts.settleTimeoutSec,
          ),
        );
        if (notSettled > 0) {
          process.stderr.write(
            `[bench] N=${n}: ${notSettled} CP(s) did not report connected within ${opts.settleTimeoutSec}s\n`,
          );
        }

        // The cohort's first global fleet index: `created` was just appended, so
        // the cohort occupies the tail of `allCpIds`. Phases are assigned from
        // these stable indices and never revisited, so growing the fleet never
        // re-phases a charge point that is already cycling.
        const load = armLoad(
          pool,
          created,
          allCpIds.length - created.length,
          runEpochMs,
          runId,
          opts,
          watcher,
        );
        stopLoads.push(load.stop);
        loads.push(load);
        await untilLost(load.ready);

        // Warm up *before* the `before` scrape, not after it. Every counter
        // below is a delta between the two scrapes, and a watchdog timeout
        // increments 30s after the CALL it belongs to — so without holding this
        // N and its load steady for the stagger ramp plus one watchdog
        // interval, the delta would carry expirations for calls issued during
        // the previous step, this step's boot, or its ramp, and the first
        // non-zero timeout would be reported at a larger N than the one that
        // produced it.
        if (opts.warmupSec > 0) {
          process.stderr.write(
            `[bench] N=${n}: warming up for ${opts.warmupSec}s before the first scrape\n`,
          );
          await untilLost(sleep(opts.warmupSec * 1000));
        }

        process.stderr.write(
          `[bench] N=${n}: measuring for ${opts.durationSec}s\n`,
        );
        const before = await untilLost(
          fetchMetrics(opts.daemonUrl, opts.daemonBasicAuth),
        );
        await untilLost(sleep(opts.durationSec * 1000));
        const after = await untilLost(
          fetchMetrics(opts.daemonUrl, opts.daemonBasicAuth),
        );

        const deltas = diffHistogram(before, after, CALL_DURATION_METRIC);
        const aggregate = mergeHistogramDeltas(deltas);
        const hbDelta = deltas.get("Heartbeat");
        const heartbeat = hbDelta
          ? mergeHistogramDeltas(new Map([["Heartbeat", hbDelta]]))
          : null;

        const errorsAfter = after
          .filter((s) => s.name === "ocppcp_ocpp_call_errors_total")
          .reduce((sum, s) => sum + s.value, 0);
        const errorsBefore = before
          .filter((s) => s.name === "ocppcp_ocpp_call_errors_total")
          .reduce((sum, s) => sum + s.value, 0);
        const reconnectsAfter =
          after.find((s) => s.name === "ocppcp_ws_reconnects_total")?.value ??
          0;
        const reconnectsBefore =
          before.find((s) => s.name === "ocppcp_ws_reconnects_total")?.value ??
          0;
        const timeoutsAfter = after
          .filter((s) => s.name === CALL_TIMEOUTS_METRIC)
          .reduce((sum, s) => sum + s.value, 0);
        const timeoutsBefore = before
          .filter((s) => s.name === CALL_TIMEOUTS_METRIC)
          .reduce((sum, s) => sum + s.value, 0);
        const evictionsAfter =
          after.find((s) => s.name === PENDING_EVICTIONS_METRIC)?.value ?? 0;
        const evictionsBefore =
          before.find((s) => s.name === PENDING_EVICTIONS_METRIC)?.value ?? 0;
        const evictions = Math.max(0, evictionsAfter - evictionsBefore);
        // The one case where p50/p95 are silently incomplete: an evicted CALL
        // loses its duration sample, and 4096 concurrent pending CALLs is a
        // condition this sweep is built to reach.
        if (evictions > 0) {
          process.stderr.write(
            `[bench] N=${n}: WARNING: the daemon's correlation cache evicted ` +
              `${evictions} in-flight CALL(s) during this window, so the latency ` +
              `below is missing that many observations. Not timeouts — the calls ` +
              `may well have been answered.\n`,
          );
        }
        const unconfirmedStarts = loads.reduce(
          (sum, l) => sum + l.unconfirmedStarts(),
          0,
        );
        const lateHolds = loads.reduce((sum, l) => sum + l.lateHolds(), 0);
        const retired = loads.reduce((sum, l) => sum + l.retired(), 0);

        // Read from the *final* scrape, not from the settle poll: a charge point
        // that dropped during the warmup or the window would otherwise still be
        // counted, attributing this row's latency to a fleet larger than the one
        // that produced it. A warmup disconnect is the worst case — its
        // reconnect attempts land before the `before` scrape, so the
        // `reconnects` column stays 0 and nothing else in the row hints at it.
        const connectedAtEnd = fleetGauge(after).connected;
        const dropped = Math.max(0, connected - connectedAtEnd);
        if (dropped > 0) {
          process.stderr.write(
            `[bench] N=${n}: WARNING: ${dropped} charge point(s) that had settled ` +
              `were no longer connected at the end of the window; the row's ` +
              `latency comes from the ${Math.max(0, connectedAtEnd - baseline.connected)} ` +
              `still connected, not from all ${Math.max(0, connected - baseline.connected)}.\n`,
          );
        }

        results.push({
          requested: n,
          fleet: allCpIds.length,
          connectedAtSettle: Math.max(0, connected - baseline.connected),
          connectedAtEnd: Math.max(0, connectedAtEnd - baseline.connected),
          notSettled,
          aggregate,
          heartbeat,
          // Only the OCPP-1.6J handler has the watchdog that feeds this counter,
          // so on any other version it is structurally zero — and printing 0
          // would read as "no calls were abandoned" rather than "not measured".
          timeouts:
            opts.ocppVersion === OCPP_1_6
              ? Math.max(0, timeoutsAfter - timeoutsBefore)
              : null,
          evictions,
          errors: Math.max(0, errorsAfter - errorsBefore),
          reconnects: Math.max(0, reconnectsAfter - reconnectsBefore),
          unconfirmedStarts: unconfirmedStarts - unconfirmedStartsBefore,
          lateHolds: lateHolds - lateHoldsBefore,
          retired: retired - retiredBefore,
        });
        unconfirmedStartsBefore = unconfirmedStarts;
        lateHoldsBefore = lateHolds;
        retiredBefore = retired;
      }
    })();
    sweepSettled = sweep;
    await sweep;
  } finally {
    await cleanup();
  }

  const table = formatTable([...STEP_COLUMNS], results.map(row));
  process.stdout.write("\n" + table + "\n");

  if (opts.outFile) {
    const json = JSON.stringify(
      {
        // Redacted: a result file is meant to be kept, attached to an issue
        // and pasted into a doc, so the daemon's Basic Auth password and any
        // userinfo embedded in a URL must not travel with it.
        options: redactOptions(opts),
        // Recorded so a leftover fleet can be traced back to the run that made
        // it, and so two result files are never confused.
        runId,
        preExistingChargePoints: baseline.total,
        // Says whose hardware it is; `daemonHostIsRunner` makes that
        // machine-readable, so a collected result can be filtered rather than
        // read hopefully.
        machine: machineInfo(opts.daemonUrl, daemonVersion),
        daemonHostIsRunner: daemonIsLocal(opts.daemonUrl),
        results: results.map((r) => ({
          // `n` is the fleet the row's numbers actually describe.
          // `requested` is the `--counts` entry it was aiming for; they differ
          // whenever `cp.create_many` only partly succeeded.
          n: r.fleet,
          requested: r.requested,
          notCreated: r.requested - r.fleet,
          // Both ends of the step, explicitly: `connected` is what generated
          // the histogram, `connectedAtSettle` is what the window opened with.
          connected: r.connectedAtEnd,
          connectedAtSettle: r.connectedAtSettle,
          droppedDuringWindow: droppedDuringWindow(r),
          notSettled: r.notSettled,
          calls: r.aggregate.count,
          p50Seconds: valueOrNull(histogramQuantile(r.aggregate, 0.5)),
          p95Seconds: valueOrNull(histogramQuantile(r.aggregate, 0.95)),
          heartbeatP50Seconds: r.heartbeat
            ? valueOrNull(histogramQuantile(r.heartbeat, 0.5))
            : null,
          heartbeatP95Seconds: r.heartbeat
            ? valueOrNull(histogramQuantile(r.heartbeat, 0.95))
            : null,
          timeouts: r.timeouts,
          correlationCacheEvictions: r.evictions,
          answeredAfterWatchdog: answeredAfterWatchdog(r),
          errors: r.errors,
          reconnects: r.reconnects,
          unconfirmedTransactionStarts: r.unconfirmedStarts,
          lateHolds: r.lateHolds,
          retiredChargePoints: r.retired,
        })),
      },
      null,
      2,
    );
    await Bun.write(opts.outFile, json);
    process.stderr.write(`[bench] wrote ${opts.outFile}\n`);
  }
}

function valueOrNull(q: ReturnType<typeof histogramQuantile>): number | null {
  return q.kind === "value" ? q.seconds : null;
}

/** Charge points per second of `--tx-interval` the full pool sustains — the
 *  ceiling `validateOptions` enforces, quoted in `--help` and the README. */
const MAX_SUSTAINABLE_PER_TX_SEC = maxSustainableFleet(2) / 2;

function printUsage(): void {
  process.stderr
    .write(`Usage: bun scripts/bench/fleet-bench.ts --csms-url <url> --daemon-url <url> [options]

Required:
  --csms-url <url>            CSMS the benchmarked fleet connects to (ws:// or wss://; OCPP-J only)
  --daemon-url <url>          This simulator's daemon control plane (http(s)://)

Options:
  --counts <n,n,...>          Ascending fleet sizes to sweep (default 10,50,100,200)
  --duration <seconds>        Measurement window per step (default 60)
  --heartbeat-interval <sec>  Heartbeat cadence applied to every CP (default 5)
  --tx-interval <seconds>     Start/stop transaction cycle period; 0 = idle/heartbeat-only (default 0)
                              The socket pool sustains ${MAX_SUSTAINABLE_PER_TX_SEC} charge points per second
                              of --tx-interval; a larger sweep is refused rather than
                              run at less load than configured
  --settle-timeout <seconds>  How long to wait for new CPs to connect per step (default 60)
  --warmup <seconds>          Hold the new N and its load this long before the first
                              scrape, so a step's timeouts are its own
                              (default ${CALL_WATCHDOG_SEC} + --tx-interval)
  --ocpp-version <version>    OCPP version every benchmarked CP is created with
                              (default OCPP-1.6J; one of ${BENCH_OCPP_VERSIONS.join(", ")})
  --health-path <path>        Daemon health path (default /v1/healthz)
  --daemon-basic-auth-user <u>
  --daemon-basic-auth-pass <p>  Basic Auth for a protected daemon (both or neither)
  --allow-existing            Run even though the daemon already holds charge points
                              (their traffic is inside every measurement window)
  --out <path>                Also write full results as JSON to this path
                              (credentials redacted)

See scripts/bench/README.md for a worked example and what to record.
`);
}

// Guarded the way `src/cli/main.ts` and `scripts/steve-verify/runner/main.ts`
// guard theirs, so importing this module — from a test, or from a tool that
// wants one of its helpers — does not start a benchmark run.
if (import.meta.main) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    // An abort is a run that stopped on purpose, not a crash — say so, because
    // the difference decides whether the operator looks for a bug or for a
    // daemon that went away.
    process.stderr.write(
      `${err instanceof BenchAbortError ? "Aborted" : "Error"}: ${message}\n`,
    );
    // `process.exit`, not `exitCode`, and for the same reason the SIGINT handler
    // uses it. `Promise.race` does not cancel the loser, so an abort that
    // interrupted the measurement sleep leaves that timer armed — up to
    // `--duration` or `--warmup`, an hour each at their caps — and an in-flight
    // `pool.rpc` leaves its own. The message would print at once and the process
    // would then sit there, which is not a stop. `main`'s `finally` has already
    // awaited `cleanup()` by the time this runs, so nothing is cut short.
    process.exit(1);
  });
}
