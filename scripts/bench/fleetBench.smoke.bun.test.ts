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
// ---------------------------------------------------------------------------

interface MockCsms {
  readonly wsUrl: string;
  /** Stop answering entirely, while keeping the socket open — the "CSMS went
   *  black" case the run has to survive rather than hang on. */
  blackHole(): void;
  stop(): void;
}

function startMockCsms(): MockCsms {
  let blackHoled = false;
  let transactionId = 1;
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
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
        const [, messageId, action] = frame as [number, string, string];
        ws.send(JSON.stringify([3, messageId, confFor(action)]));
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
    blackHole: () => {
      blackHoled = true;
    },
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
