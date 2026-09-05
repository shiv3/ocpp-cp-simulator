// End-to-end smoke test for `fleet-bench.ts` (issue #302).
//
// WHY THIS EXISTS, when `lib.bun.test.ts` already covers the pure logic:
// reviewing this tool surfaced two classes of defect that unit tests
// structurally cannot catch, and both recurred round after round.
//
//   * **"The process never exits."** A pool left connected on a setup failure,
//     a timer set that grew without bound, a sequential 35s cleanup, the loser
//     of a `Promise.race` that nothing cancels, an unbounded `fetch`. Five
//     separate findings. No assertion about a function detects any of them —
//     only running the real process under a wall-clock bound does.
//   * **Sweep-level composition.** A function correct in isolation that breaks
//     across steps or against pre-existing daemon state: the stagger was armed
//     per cohort, the id cursor restarted inside the previous step's range,
//     cleanup deleted charge points it had not created. The stagger is the
//     proof — a *tested* `lib.ts` function recurred twice because the bug was
//     in how `main()` called it, not in the function.
//
// So this spawns the real script as a subprocess against a real daemon and a
// real mock CSMS, and asserts about the run rather than about any function.
// It is slow by the standards of this suite (tens of seconds) and that is the
// price of testing the thing that actually broke.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { io, type Socket } from "socket.io-client";

import { BENCH_ID_ROOT } from "./lib.ts";

/** Generous on purpose. The assertion is "it terminates at all", not "it is
 *  fast": a tight bound would make this flaky on a loaded CI host and the
 *  flake would be indistinguishable from the hang it exists to catch. A run
 *  configured as below takes ~20s; anything past this is a hang. */
const RUN_BUDGET_MS = 180_000;

const BENCH_SCRIPT = join(import.meta.dir, "fleet-bench.ts");
const DAEMON_SCRIPT = join(
  import.meta.dir,
  "..",
  "..",
  "src",
  "cli",
  "main.ts",
);

// ---------------------------------------------------------------------------
// A mock CSMS that answers the whole transaction cycle.
//
// READ THIS BEFORE TRUSTING A PASS HERE. This mock is deliberately far more
// forgiving than a real CSMS, and a green run says nothing about the things it
// does not enforce:
//
//   * **No subprotocol negotiation.** `srv.upgrade(req)` accepts any client and
//     echoes no `Sec-WebSocket-Protocol`, where gocpp uses
//     `WithSubProtocols("ocpp1.6")` and rejects a mismatch. So the failure the
//     README warns about most loudly — pointing a 1.6J fleet at a 2.x-only
//     CSMS, which shows up as an unsettled fleet and an empty table — **cannot
//     be reproduced here**. Against gocpp that fleet reports `Unavailable`;
//     against this mock it reports `Available`. Version and handshake
//     behaviour must be checked against a real CSMS, not against this file.
//   * **No schema validation, and never a CALLERROR.** Every CALL is acked, so
//     the table's `errors` column is structurally untestable here — it can only
//     ever read 0, whatever the payload.
//   * **Unknown actions get `{}`.** A CALL this mock has never heard of still
//     succeeds, so a wrong or misspelled action passes silently.
//
// What it is good for is the two classes this file exists to cover: that the
// run terminates, and that it composes correctly across sweep steps and
// against pre-existing daemon state. Neither needs a strict CSMS.
// ---------------------------------------------------------------------------

interface MockCsms {
  readonly wsUrl: string;
  /** StartTransaction minus StopTransaction. A run must leave this at zero:
   *  the CSMS is a third-party system whose state the benchmark cannot
   *  enumerate, so the only way to leave it as found is to close what was
   *  opened, before the charge point that could close it is deleted. */
  openTransactions(): number;
  /** Distinct idTags seen in Authorize/StartTransaction. */
  idTags(): string[];
  /** Stop answering entirely, while keeping the socket open — the "CSMS went
   *  black" case the run has to survive rather than hang on. */
  blackHole(): void;
  /** How many WebSockets `cpId` has opened. `>= 2` is the only proof available
   *  here that a reconnect really happened. */
  connections(cpId: string): number;
  /** Heartbeats `cpId` sent on its `n`-th connection (1-based). Counted at the
   *  CSMS, off the wire, so it owes nothing to any state the benchmark keeps
   *  about itself. */
  heartbeatsOnConnection(cpId: string, n: number): number;
  /** Every charge point id that has connected. */
  chargePointIds(): string[];
  stop(): void;
}

interface MockCsmsOptions {
  /** Close each charge point's socket exactly once, right after answering its
   *  first Heartbeat, so the reconnect → BootNotification → `Accepted` path
   *  runs under a live benchmark. */
  readonly dropOnFirstHeartbeat?: boolean;
}

/** Per-socket bookkeeping, so a Heartbeat can be attributed to the connection
 *  it arrived on rather than to the charge point in aggregate. */
interface CsmsSocketData {
  readonly cpId: string;
  /** 1-based: the first connection is 1, the one after a reconnect is 2. */
  readonly connection: number;
}

function startMockCsms(options: MockCsmsOptions = {}): MockCsms {
  let blackHoled = false;
  let transactionId = 1;
  let open = 0;
  const seenIdTags = new Set<string>();
  /** cpId -> how many sockets it has opened. */
  const connectionCounts = new Map<string, number>();
  /** cpId -> heartbeats per connection, indexed by `connection - 1`. */
  const heartbeats = new Map<string, number[]>();
  /** cpIds already dropped once, so the drop happens exactly once each. */
  const alreadyDropped = new Set<string>();
  const server = Bun.serve<CsmsSocketData, never>({
    port: 0,
    fetch(req, srv) {
      // `wsUrlWithBasic.ts` appends the charge point id to the supervision
      // URL's path (`url.pathname += params.chargePointId`), so this is who is
      // connecting.
      const cpId = decodeURIComponent(
        new URL(req.url).pathname.replace(/^\//, ""),
      );
      const connection = (connectionCounts.get(cpId) ?? 0) + 1;
      if (srv.upgrade(req, { data: { cpId, connection } })) {
        connectionCounts.set(cpId, connection);
        return undefined;
      }
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      message(ws, raw) {
        if (blackHoled) return;
        let frame: unknown;
        try {
          frame = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (!Array.isArray(frame) || frame[0] !== 2) return;
        const [, messageId, action, payload] = frame as [
          number,
          string,
          string,
          Record<string, unknown> | undefined,
        ];
        const idTag = payload?.idTag;
        if (typeof idTag === "string") seenIdTags.add(idTag);
        if (action === "StartTransaction") open++;
        if (action === "StopTransaction") open--;
        const { cpId, connection } = ws.data;
        if (action === "Heartbeat") {
          const perConnection = heartbeats.get(cpId) ?? [];
          perConnection[connection - 1] =
            (perConnection[connection - 1] ?? 0) + 1;
          heartbeats.set(cpId, perConnection);
        }
        ws.send(JSON.stringify([3, messageId, confFor(action)]));
        if (
          options.dropOnFirstHeartbeat &&
          action === "Heartbeat" &&
          !alreadyDropped.has(cpId)
        ) {
          // After the conf, not before it: an unanswered CALL would put the
          // charge point into its watchdog path and confuse what this is
          // testing. A server-initiated close is not a manual disconnect, so
          // `OCPPWebSocket.attemptReconnect` runs with its 1s first backoff.
          alreadyDropped.add(cpId);
          ws.close();
        }
      },
    },
  });

  function confFor(action: string): Record<string, unknown> {
    const now = new Date().toISOString();
    switch (action) {
      case "BootNotification":
        return { status: "Accepted", currentTime: now, interval: 300 };
      case "Heartbeat":
        return { currentTime: now };
      case "Authorize":
        return { idTagInfo: { status: "Accepted" } };
      case "StartTransaction":
        return {
          transactionId: transactionId++,
          idTagInfo: { status: "Accepted" },
        };
      case "StopTransaction":
        return { idTagInfo: { status: "Accepted" } };
      default:
        // StatusNotification, MeterValues, DataTransfer, ...
        return {};
    }
  }

  return {
    wsUrl: server.url.toString().replace(/^http/, "ws"),
    openTransactions: () => open,
    idTags: () => [...seenIdTags],
    blackHole: () => {
      blackHoled = true;
    },
    connections: (cpId) => connectionCounts.get(cpId) ?? 0,
    heartbeatsOnConnection: (cpId, n) => heartbeats.get(cpId)?.[n - 1] ?? 0,
    chargePointIds: () => [...connectionCounts.keys()],
    stop: () => server.stop(true),
  };
}

// ---------------------------------------------------------------------------
// The real daemon, as a subprocess.
// ---------------------------------------------------------------------------

interface Daemon {
  readonly url: string;
  stop(): void;
}

async function startDaemon(): Promise<Daemon> {
  const port = await freePort();
  const proc = Bun.spawn(
    [
      "bun",
      DAEMON_SCRIPT,
      "--http-port",
      String(port),
      "--metrics",
      "--metrics-no-auth",
    ],
    { stdout: "pipe", stderr: "pipe", cwd: join(import.meta.dir, "..", "..") },
  );
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`daemon did not become healthy on ${url}`);
    }
    try {
      const res = await fetch(`${url}/v1/healthz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (res.ok && ((await res.json()) as { ok?: boolean }).ok) break;
    } catch {
      // not up yet
    }
    await Bun.sleep(200);
  }
  return { url, stop: () => proc.kill() };
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port ?? 0;
  probe.stop(true);
  if (port === 0) throw new Error("could not reserve a port");
  return port;
}

// ---------------------------------------------------------------------------
// Control-plane helpers, for arranging and inspecting daemon state.
// ---------------------------------------------------------------------------

async function withControlPlane<T>(
  daemonUrl: string,
  fn: (
    rpc: (method: string, params: unknown) => Promise<unknown>,
  ) => Promise<T>,
): Promise<T> {
  const socket: Socket = io(daemonUrl, { path: "/socket.io/" });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no connect")), 10_000);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("connect_error", (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    return await fn(
      (method, params) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`${method} timed out`)),
            15_000,
          );
          socket.emit(
            "rpc",
            { method, params },
            (
              ack:
                | { ok: true; result: unknown }
                | { ok: false; error: { code: string; message: string } },
            ) => {
              clearTimeout(timer);
              if (ack.ok) resolve(ack.result);
              else reject(new Error(`${ack.error.code}: ${ack.error.message}`));
            },
          );
        }),
    );
  } finally {
    socket.disconnect();
  }
}

async function listCpIds(daemonUrl: string): Promise<string[]> {
  return withControlPlane(daemonUrl, async (rpc) => {
    const result = (await rpc("cp.list", {})) as
      { cps?: { cpId: string }[] } | { cpId: string }[];
    const cps = Array.isArray(result) ? result : (result.cps ?? []);
    return cps.map((c) => c.cpId);
  });
}

interface RunOutcome {
  readonly exitCode: number | null;
  readonly elapsedMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** Run the real script as a subprocess, under a hard wall-clock bound. */
async function runBench(args: readonly string[]): Promise<RunOutcome> {
  const startedAt = Date.now();
  const proc = Bun.spawn(["bun", BENCH_SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: join(import.meta.dir, "..", ".."),
  });
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, RUN_BUDGET_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(killer);
  return {
    exitCode,
    elapsedMs: Date.now() - startedAt,
    stdout,
    stderr,
    timedOut,
  };
}

// ---------------------------------------------------------------------------

describe("fleet-bench end to end (#302)", () => {
  let csms: MockCsms;
  let daemon: Daemon;
  let outDir: string;

  beforeAll(async () => {
    csms = startMockCsms();
    daemon = await startDaemon();
    outDir = mkdtempSync(join(tmpdir(), "fleet-bench-smoke-"));
  });

  afterAll(() => {
    daemon?.stop();
    csms?.stop();
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  function baseArgs(outFile: string, extra: readonly string[] = []): string[] {
    return [
      "--csms-url",
      csms.wsUrl,
      "--daemon-url",
      daemon.url,
      "--counts",
      "1,2",
      "--duration",
      "5",
      "--heartbeat-interval",
      "1",
      "--warmup",
      "0",
      "--settle-timeout",
      "10",
      "--out",
      outFile,
      ...extra,
    ];
  }

  it("completes a two-step sweep, reports both steps, and cleans up after itself", async () => {
    const outFile = join(outDir, "sweep.json");
    const run = await runBench(baseArgs(outFile));

    // 1. It terminates, inside a hard bound. This is the assertion that covers
    //    the whole "process never exits" class — the timer leak, the pool left
    //    connected, the uncancelled race loser, the unbounded fetch. None of
    //    them is visible to a unit test.
    expect(run.timedOut).toBe(false);
    expect(run.exitCode).toBe(0);
    expect(run.elapsedMs).toBeLessThan(RUN_BUDGET_MS);

    // 2. Both steps are reported, and each row is labelled with the fleet it
    //    describes — the composition-across-steps property.
    const report = JSON.parse(readFileSync(outFile, "utf8")) as {
      runId: string;
      results: { n: number; connected: number; calls: number }[];
    };
    expect(report.results).toHaveLength(2);
    expect(report.results.map((r) => r.n)).toEqual([1, 2]);
    expect(report.runId).toBeTruthy();
    for (const r of report.results) {
      expect(r.connected).toBe(r.n);
    }
    // The printed table carries a row per step too, not just the JSON.
    const tableRows = run.stdout
      .split("\n")
      .filter((line) => /^\d+\s/.test(line.trim()));
    expect(tableRows).toHaveLength(2);
    // A real CSMS answered, so the run measured something.
    expect(report.results.at(-1)!.calls).toBeGreaterThan(0);

    // 3. Cleanup actually ran: the daemon holds none of this run's fleet.
    expect(await listCpIds(daemon.url)).toEqual([]);
  }, 240_000);

  it("never deletes a charge point it did not create", async () => {
    // The round-seven P1, as an explicit regression. Before the fix a
    // pre-existing charge point sitting on an id the bench would offer was
    // reported as a create failure — because it already existed — and then
    // deleted at teardown, destroying a fleet the benchmark never made.
    //
    // The primary fix is that this collision is now unrepresentable: every run
    // creates under its own `BENCH-<runid>-` prefix. The bystander below is
    // named with the *old* colliding pattern precisely so that a regression to
    // a shared prefix would fail this test.
    const bystander = `${BENCH_ID_ROOT}000001`;
    await withControlPlane(daemon.url, (rpc) =>
      rpc("cp.create", {
        cpId: bystander,
        wsUrl: csms.wsUrl,
        connectors: 1,
        vendor: "someone-else",
        model: "precious",
        autoConnect: false,
      }),
    );

    try {
      const outFile = join(outDir, "allow-existing.json");
      const run = await runBench(baseArgs(outFile, ["--allow-existing"]));
      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBe(0);

      // The bystander survives, and nothing of the bench's own fleet is left.
      const after = await listCpIds(daemon.url);
      expect(after).toContain(bystander);
      expect(after.filter((id) => id !== bystander)).toEqual([]);
    } finally {
      await withControlPlane(daemon.url, (rpc) =>
        rpc("cp.delete", { cpId: bystander }),
      ).catch(() => undefined);
    }
  }, 240_000);

  it("keeps heartbeating at --heartbeat-interval across a reconnect", async () => {
    // The round-nine P1, as a run-level regression, and the only assertion in
    // this repo that can settle it.
    //
    // `cp.start_heartbeat` does not *pin* an interval. Every accepted boot runs
    // `ChargePoint.onBootNotificationAccepted`, which calls
    // `startHeartbeat(BootNotification.conf.interval)` — so the CSMS's value
    // replaces the flag's on every reconnect, and reconnects are exactly what
    // begins to happen as a sweep approaches the knee. Arming once per cohort
    // meant the offered load changed at the precise point the benchmark exists
    // to measure, and every later step inherited the drift.
    //
    // WHY THIS IS NOT CIRCULAR. The mock answers BootNotification with
    // `interval: 300`, and the run asks for 1s. The evidence is Heartbeat
    // *frames counted at the CSMS*, per connection — not a value the fix
    // writes anywhere. If the override did not survive the reconnect the
    // charge point would be on the CSMS's 300s cadence and connection #2 would
    // carry no Heartbeat at all inside this window; the previous two "proof
    // the stop reached the CSMS" mechanisms were both refuted for reading back
    // something the local side had already set, and this reads the wire.
    const flappy = startMockCsms({ dropOnFirstHeartbeat: true });
    try {
      const outFile = join(outDir, "heartbeat-override.json");
      const run = await runBench([
        "--csms-url",
        flappy.wsUrl,
        "--daemon-url",
        daemon.url,
        "--counts",
        "1",
        // Long enough for: first Heartbeat (~1s) → drop → 1s reconnect backoff
        // → re-boot → the reapplied override → at least one more Heartbeat.
        "--duration",
        "15",
        "--heartbeat-interval",
        "1",
        "--warmup",
        "0",
        "--settle-timeout",
        "10",
        "--out",
        outFile,
      ]);
      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBe(0);

      const cpIds = flappy.chargePointIds();
      expect(cpIds).toHaveLength(1);
      const cpId = cpIds[0]!;

      // Precondition, asserted rather than assumed: without a second
      // connection the heartbeat assertion below is vacuous — it would be
      // satisfied by a run in which nothing ever dropped.
      expect(flappy.connections(cpId)).toBeGreaterThanOrEqual(2);
      expect(flappy.heartbeatsOnConnection(cpId, 1)).toBeGreaterThanOrEqual(1);

      // The discriminating assertion. On connection #2 the charge point has
      // been told 300s by this CSMS; any Heartbeat here at all is the run's
      // own `--heartbeat-interval` having been put back.
      expect(flappy.heartbeatsOnConnection(cpId, 2)).toBeGreaterThanOrEqual(1);

      // And the run says so in its own record, so a result file collected from
      // a real sweep carries the same fact.
      const report = JSON.parse(readFileSync(outFile, "utf8")) as {
        heartbeatOverride: { reapplied: number; failed: number };
      };
      expect(report.heartbeatOverride.reapplied).toBeGreaterThanOrEqual(1);
      expect(report.heartbeatOverride.failed).toBe(0);

      expect(await listCpIds(daemon.url)).toEqual([]);
    } finally {
      flappy.stop();
    }
  }, 240_000);

  it("runs the active axis, the one #302 calls the one that matters", async () => {
    // The other cases all run `--tx-interval 0`, so they exercise none of the
    // transaction cycle, the epoch-anchored stagger, or the `unconf.tx`
    // accounting. (The event socket itself is no longer one of them: it is
    // opened on both axes now, because the heartbeat override rides on it.)
    // Every one of those was a source of findings, and all of them are
    // run-level rather than function-level.
    const outFile = join(outDir, "active.json");
    const run = await runBench([
      "--csms-url",
      csms.wsUrl,
      "--daemon-url",
      daemon.url,
      "--counts",
      "2",
      "--tx-interval",
      "2",
      "--duration",
      "6",
      "--heartbeat-interval",
      "1",
      "--warmup",
      "0",
      "--settle-timeout",
      "10",
      "--out",
      outFile,
    ]);

    expect(run.timedOut).toBe(false);
    expect(run.exitCode).toBe(0);

    const report = JSON.parse(readFileSync(outFile, "utf8")) as {
      results: {
        n: number;
        calls: number;
        unconfirmedTransactionStarts: number;
      }[];
    };
    expect(report.results).toHaveLength(1);
    const step = report.results[0]!;
    expect(step.n).toBe(2);
    // Transactions really ran: a start/stop pair is several CALLs beyond the
    // heartbeats an idle fleet would produce.
    expect(step.calls).toBeGreaterThan(0);
    // Every start was confirmed off the event socket. A non-zero count here
    // would mean the watcher never saw `transaction_started` — the run would
    // still pass its other assertions while applying less load than asked for.
    expect(step.unconfirmedTransactionStarts).toBe(0);
    // The event socket was opened, and closed again with the rest of teardown.
    expect(await listCpIds(daemon.url)).toEqual([]);

    // The run left the CSMS as it found it. Teardown used to cancel the very
    // timers that would have sent stop_transaction — roughly half the fleet is
    // inside its hold at any moment — and then delete the charge points, so
    // the CSMS was left holding transactions that could never be ended. That
    // is a third-party resource the run cannot enumerate or reconcile, so the
    // only defence is closing what was opened before deleting.
    expect(csms.openTransactions()).toBe(0);

    // And each charge point presented its own idTag. Sharing one makes a CSMS
    // that enforces per-idTag concurrency reject the concurrent starts, so the
    // run would apply a fraction of the load it reports.
    const tags = csms.idTags();
    expect(tags.length).toBeGreaterThanOrEqual(2);
    expect(new Set(tags).size).toBe(tags.length);
    expect(tags).not.toContain("123456");
  }, 240_000);

  it("still terminates when the daemon dies underneath it", async () => {
    // The control plane going away mid-run is the other half of the
    // never-exits class, and the one the socket pool touches: Socket.IO
    // buffers an emit issued on a disconnected socket and flushes it on
    // reconnect, so a pool that keeps emitting into a dead daemon has RPCs
    // that neither complete nor fail promptly. A dedicated daemon, because
    // this test kills it.
    const doomed = await startDaemon();
    const outFile = join(outDir, "daemon-death.json");
    const startedAt = Date.now();
    const proc = Bun.spawn(
      [
        "bun",
        BENCH_SCRIPT,
        "--csms-url",
        csms.wsUrl,
        "--daemon-url",
        doomed.url,
        "--counts",
        "2",
        "--duration",
        "30",
        "--heartbeat-interval",
        "1",
        "--warmup",
        "0",
        "--settle-timeout",
        "10",
        "--out",
        outFile,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        cwd: join(import.meta.dir, "..", ".."),
      },
    );
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, RUN_BUDGET_MS);
    // Let the sweep get properly under way, then pull the daemon out from
    // under it, mid-measurement-window.
    await Bun.sleep(5_000);
    doomed.stop();

    const exitCode = await proc.exited;
    clearTimeout(killer);
    // Drain the pipes so the subprocess is not left blocked on a full buffer.
    await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(timedOut).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(RUN_BUDGET_MS);
    // It must end, and end as a failure rather than reporting a sweep it did
    // not finish. Which exit path it takes is not the point; not hanging is.
    expect(exitCode).not.toBe(0);
  }, 240_000);

  it("still terminates when the CSMS stops answering", async () => {
    // A CSMS that accepts the connection and then answers nothing is the
    // saturation case this tool exists to find. It must produce a report or a
    // stated failure — never a process that sits there.
    const blackHoled = startMockCsms();
    blackHoled.blackHole();
    try {
      const outFile = join(outDir, "blackhole.json");
      const run = await runBench([
        "--csms-url",
        blackHoled.wsUrl,
        "--daemon-url",
        daemon.url,
        "--counts",
        "1",
        "--duration",
        "5",
        "--heartbeat-interval",
        "1",
        "--warmup",
        "0",
        "--settle-timeout",
        "5",
        "--out",
        outFile,
      ]);
      expect(run.timedOut).toBe(false);
      expect(run.elapsedMs).toBeLessThan(RUN_BUDGET_MS);
      // Cleanup runs on the failure path too, so the daemon is left empty
      // whichever way the run ended.
      expect(await listCpIds(daemon.url)).toEqual([]);
    } finally {
      blackHoled.stop();
    }
  }, 240_000);
});
