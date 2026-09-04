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
  BenchValidationError,
  Semaphore,
  TokenBucket,
  diffHistogram,
  formatSeconds,
  formatTable,
  histogramQuantile,
  mergeHistogramDeltas,
  parseArgv,
  parseExposition,
  sleep,
  validateOptions,
  type BenchOptions,
  type Sample,
} from "./lib.ts";

const CALL_DURATION_METRIC = "ocppcp_ocpp_call_duration_seconds";

// Per-socket pacing, kept safely under the daemon's `RPC_RATE_PER_SEC` (100)
// and `INFLIGHT_CAP` (64) so this script's own control-plane traffic never
// gets itself rate-limited or mistaken for the thing being measured — the
// OCPP wire traffic these RPCs trigger is asynchronous and not bounded by
// this pacing (see the README's "Why a socket pool" section).
const RPC_RATE_PER_SOCKET = 80;
const INFLIGHT_PER_SOCKET = 48;
const MAX_SOCKETS = 10;
const CPS_PER_SOCKET = 200;
const RPC_TIMEOUT_MS = 35_000;

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
    for (let i = 0; i < count; i++) {
      const socket = io(daemonUrl, {
        path: "/socket.io/",
        auth: auth ?? undefined,
        reconnection: true,
      });
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
    return new SocketPool(pooled);
  }

  /** Round-robin one pooled socket, gated by its own rate + concurrency
   *  budget. `cpId` is omitted for daemon-level methods (`cp.create_many`,
   *  `cp.list`, ...). */
  async rpc<T = unknown>(
    method: string,
    params: unknown,
    cpId?: string,
  ): Promise<T> {
    const p = this.pooled[this.rr % this.pooled.length]!;
    this.rr++;
    await p.bucket.take();
    const release = await p.sem.acquire();
    try {
      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new RpcFailedError("timeout", `${method} timed out`)),
          RPC_TIMEOUT_MS,
        );
        p.socket.emit(
          "rpc",
          { cpId, method, params },
          (
            ack:
              | { ok: true; result: T }
              | { ok: false; error: { code: string; message: string } },
          ) => {
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

  async closeAll(): Promise<void> {
    for (const p of this.pooled) p.socket.disconnect();
  }
}

interface CpListItem {
  readonly cpId: string;
  readonly status: string;
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
  const res = await fetch(`${daemonUrl}/metrics`, { headers });
  if (!res.ok) {
    throw new Error(`GET /metrics -> ${res.status} ${res.statusText}`);
  }
  return parseExposition(await res.text());
}

async function preflight(opts: BenchOptions): Promise<void> {
  const headers: Record<string, string> = {};
  if (opts.daemonBasicAuth) {
    headers.Authorization =
      "Basic " +
      Buffer.from(
        `${opts.daemonBasicAuth.username}:${opts.daemonBasicAuth.password}`,
      ).toString("base64");
  }
  const healthRes = await fetch(`${opts.daemonUrl}${opts.healthPath}`, {
    headers,
  }).catch((err: unknown) => {
    throw new Error(
      `could not reach the daemon at ${opts.daemonUrl}${opts.healthPath}: ${String(err)}`,
    );
  });
  if (!healthRes.ok) {
    throw new Error(
      `daemon health check failed: ${healthRes.status} ${healthRes.statusText}`,
    );
  }
  const health = (await healthRes.json()) as { ok?: boolean; version?: string };
  if (!health.ok) {
    throw new Error(`daemon health check returned ok:false`);
  }

  const metricsRes = await fetch(`${opts.daemonUrl}/metrics`, { headers });
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
}

function machineInfo(daemonVersion: string): string {
  const cpus = os.cpus();
  const model = cpus[0]?.model ?? "unknown CPU";
  const cores = cpus.length;
  const memGb = (os.totalmem() / 1024 ** 3).toFixed(1);
  return [
    `machine: ${model} (${cores} cores), ${memGb} GiB RAM, ${os.platform()}/${os.arch()}`,
    `bun: ${Bun.version}, daemon: ${daemonVersion}`,
  ].join("\n");
}

/** Create `count` more CPs, starting at `startIndex`, chunked at
 *  `CP_CREATE_MANY_MAX` per call. Returns every id `cp.create_many` reported
 *  created; failures are logged and excluded rather than retried, matching
 *  `cp.create_many`'s own partial-success contract. */
async function growFleet(
  pool: SocketPool,
  opts: BenchOptions,
  startIndex: number,
  count: number,
): Promise<string[]> {
  const created: string[] = [];
  let remaining = count;
  let index = startIndex;
  while (remaining > 0) {
    const chunk = Math.min(remaining, CP_CREATE_MANY_MAX);
    const result = await pool.rpc<{
      created: string[];
      failed: { cpId: string; reason: string }[];
    }>("cp.create_many", {
      wsUrl: opts.csmsUrl,
      connectors: 1,
      vendor: "ocpp-cp-simulator",
      model: "fleet-bench",
      autoConnect: true,
      count: chunk,
      idPattern: "BENCH{n:06}",
      startIndex: index,
    });
    created.push(...result.created);
    for (const f of result.failed) {
      process.stderr.write(
        `[bench] create failed for ${f.cpId}: ${f.reason}\n`,
      );
    }
    index += chunk;
    remaining -= chunk;
  }
  return created;
}

/** Poll `cp.list` until every id in `cpIds` reports a status other than
 *  "Unavailable" (the value `ChargePoint.status` takes on disconnect / before
 *  boot) or the timeout elapses. Returns the count still not settled. */
async function waitForSettle(
  pool: SocketPool,
  cpIds: readonly string[],
  timeoutSec: number,
): Promise<number> {
  const pending = new Set(cpIds);
  const deadline = Date.now() + timeoutSec * 1000;
  while (pending.size > 0 && Date.now() < deadline) {
    const list = await pool.rpc<CpListItem[]>("cp.list", {});
    for (const item of list) {
      if (pending.has(item.cpId) && item.status !== "Unavailable") {
        pending.delete(item.cpId);
      }
    }
    if (pending.size > 0) await sleep(500);
  }
  return pending.size;
}

/** Arm each given CP's heartbeat at the configured cadence and, in active
 *  mode, kick off a staggered start/stop transaction cycle that runs until
 *  `stop()` is called. Called once per step with only that step's newly
 *  created CPs — earlier steps' CPs keep running under their own handle. */
function armLoad(
  pool: SocketPool,
  cpIds: readonly string[],
  opts: BenchOptions,
): { stop: () => void; ready: Promise<void> } {
  let stopped = false;
  const timers: ReturnType<typeof setTimeout>[] = [];

  const ready = (async () => {
    for (const cpId of cpIds) {
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
    if (opts.txIntervalSec <= 0) return;
    for (const cpId of cpIds) {
      // Stagger each CP's first cycle across one interval so the fleet
      // reaches steady state instead of bursting in lockstep.
      const offsetMs = Math.random() * opts.txIntervalSec * 1000;
      const timer = setTimeout(() => void cycle(cpId), offsetMs);
      timers.push(timer);
    }
  })();

  async function cycle(cpId: string): Promise<void> {
    if (stopped) return;
    try {
      await pool.rpc("start_transaction", { connector: 1 }, cpId);
    } catch (err) {
      process.stderr.write(
        `[bench] start_transaction failed for ${cpId}: ${String(err)}\n`,
      );
    }
    const holdMs = Math.max(1000, (opts.txIntervalSec * 1000) / 2);
    const timer = setTimeout(async () => {
      if (stopped) return;
      try {
        await pool.rpc("stop_transaction", { connector: 1 }, cpId);
      } catch (err) {
        process.stderr.write(
          `[bench] stop_transaction failed for ${cpId}: ${String(err)}\n`,
        );
      }
      const nextTimer = setTimeout(() => void cycle(cpId), holdMs);
      timers.push(nextTimer);
    }, holdMs);
    timers.push(timer);
  }

  return {
    ready,
    stop: () => {
      stopped = true;
      for (const t of timers) clearTimeout(t);
    },
  };
}

interface StepResult {
  readonly n: number;
  readonly connected: number;
  readonly notSettled: number;
  readonly aggregate: ReturnType<typeof mergeHistogramDeltas>;
  readonly heartbeat: ReturnType<typeof mergeHistogramDeltas> | null;
  readonly errors: number;
  readonly reconnects: number;
}

function row(r: StepResult): string[] {
  const p50 = formatSeconds(histogramQuantile(r.aggregate, 0.5));
  const p95 = formatSeconds(histogramQuantile(r.aggregate, 0.95));
  const hbP50 = r.heartbeat
    ? formatSeconds(histogramQuantile(r.heartbeat, 0.5))
    : "-";
  const hbP95 = r.heartbeat
    ? formatSeconds(histogramQuantile(r.heartbeat, 0.95))
    : "-";
  // Calls slower than the last finite bucket edge (30s, the per-CALL
  // watchdog) — the `+Inf` bucket's count minus the last finite bucket's
  // cumulative count.
  const lastFiniteCount = r.aggregate.buckets.at(-1)?.count ?? 0;
  const overWatchdog = Math.max(0, r.aggregate.count - lastFiniteCount);
  return [
    String(r.n),
    String(r.connected),
    String(r.notSettled),
    String(r.aggregate.count),
    p50,
    p95,
    hbP50,
    hbP95,
    String(overWatchdog),
    String(r.errors),
    String(r.reconnects),
  ];
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

  process.stderr.write(
    `[bench] preflight: health + /metrics on ${opts.daemonUrl}\n`,
  );
  await preflight(opts);

  const healthRes = await fetch(`${opts.daemonUrl}${opts.healthPath}`);
  const health = (await healthRes.json()) as { version?: string };
  process.stderr.write(machineInfo(health.version ?? "unknown") + "\n");
  process.stderr.write(
    `[bench] mode: ${opts.txIntervalSec > 0 ? `active (tx every ~${opts.txIntervalSec}s)` : "idle (heartbeat only)"}, heartbeat every ${opts.heartbeatIntervalSec}s\n`,
  );

  const maxN = opts.counts.at(-1)!;
  const socketCount = Math.min(
    MAX_SOCKETS,
    Math.max(1, Math.ceil(maxN / CPS_PER_SOCKET)),
  );
  process.stderr.write(
    `[bench] opening ${socketCount} control-plane socket(s)\n`,
  );
  const pool = await SocketPool.connect(
    opts.daemonUrl,
    socketCount,
    opts.daemonBasicAuth,
  );

  const allCpIds: string[] = [];
  const results: StepResult[] = [];
  // One stop handle per step's `armLoad` call — steps only ever *add* CPs, so
  // each step arms just the CPs it created and earlier steps' handles keep
  // running rather than being torn down and re-armed every step (which would
  // clear in-flight transaction timers and re-issue start_transaction on
  // connectors already mid-session).
  const stopLoads: Array<() => void> = [];

  const cleanup = async () => {
    for (const stop of stopLoads) stop();
    process.stderr.write(
      `[bench] cleaning up ${allCpIds.length} charge point(s)\n`,
    );
    for (const cpId of allCpIds) {
      try {
        await pool.rpc("cp.delete", { cpId });
      } catch {
        // best-effort
      }
    }
    await pool.closeAll();
  };
  process.on("SIGINT", () => {
    void cleanup().finally(() => process.exit(130));
  });

  try {
    let currentCount = 0;
    let totalNotSettled = 0;
    for (const n of opts.counts) {
      const toCreate = n - currentCount;
      process.stderr.write(`[bench] N=${n}: creating ${toCreate} more CP(s)\n`);
      const created = await growFleet(pool, opts, currentCount + 1, toCreate);
      allCpIds.push(...created);
      currentCount = allCpIds.length;

      const notSettled = await waitForSettle(
        pool,
        created,
        opts.settleTimeoutSec,
      );
      totalNotSettled += notSettled;
      if (notSettled > 0) {
        process.stderr.write(
          `[bench] N=${n}: ${notSettled} CP(s) did not report connected within ${opts.settleTimeoutSec}s\n`,
        );
      }

      const load = armLoad(pool, created, opts);
      stopLoads.push(load.stop);
      await load.ready;

      process.stderr.write(
        `[bench] N=${n}: measuring for ${opts.durationSec}s\n`,
      );
      const before = await fetchMetrics(opts.daemonUrl, opts.daemonBasicAuth);
      await sleep(opts.durationSec * 1000);
      const after = await fetchMetrics(opts.daemonUrl, opts.daemonBasicAuth);

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
        after.find((s) => s.name === "ocppcp_ws_reconnects_total")?.value ?? 0;
      const reconnectsBefore =
        before.find((s) => s.name === "ocppcp_ws_reconnects_total")?.value ?? 0;

      results.push({
        n,
        connected: currentCount - totalNotSettled,
        notSettled: totalNotSettled,
        aggregate,
        heartbeat,
        errors: Math.max(0, errorsAfter - errorsBefore),
        reconnects: Math.max(0, reconnectsAfter - reconnectsBefore),
      });
    }
  } finally {
    await cleanup();
  }

  const table = formatTable(
    [
      "N",
      "connected",
      "unsettled",
      "calls",
      "p50",
      "p95",
      "hb p50",
      "hb p95",
      ">30s",
      "errors",
      "reconnects",
    ],
    results.map(row),
  );
  process.stdout.write("\n" + table + "\n");

  if (opts.outFile) {
    const json = JSON.stringify(
      {
        options: opts,
        machine: machineInfo(health.version ?? "unknown"),
        results: results.map((r) => ({
          n: r.n,
          connected: r.connected,
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
          errors: r.errors,
          reconnects: r.reconnects,
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

function printUsage(): void {
  process.stderr
    .write(`Usage: bun scripts/bench/fleet-bench.ts --csms-url <url> --daemon-url <url> [options]

Required:
  --csms-url <url>            CSMS the benchmarked fleet connects to (ws(s):// or http(s)://)
  --daemon-url <url>          This simulator's daemon control plane (http(s)://)

Options:
  --counts <n,n,...>          Ascending fleet sizes to sweep (default 10,50,100,200)
  --duration <seconds>        Measurement window per step (default 60)
  --heartbeat-interval <sec>  Heartbeat cadence applied to every CP (default 5)
  --tx-interval <seconds>     Start/stop transaction cycle period; 0 = idle/heartbeat-only (default 0)
  --settle-timeout <seconds>  How long to wait for new CPs to connect per step (default 60)
  --health-path <path>        Daemon health path (default /v1/healthz)
  --daemon-basic-auth-user <u>
  --daemon-basic-auth-pass <p>  Basic Auth for a protected daemon (both or neither)
  --out <path>                 Also write full results as JSON to this path

See scripts/bench/README.md for a worked example and what to record.
`);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `Error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exitCode = 1;
});
