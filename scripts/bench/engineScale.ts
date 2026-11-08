// Stage D2, item 3 (docs/analyses/charger-engine-migration.md, "Verification results"):
// how many simulated chargers fit in one Bun process on a VirtualClock?
//
//   bun scripts/bench/engineScale.ts --mode bare --n 10000 --hours 1
//   bun scripts/bench/engineScale.ts --mode cp   --n 1000  --hours 1
//   bun scripts/bench/engineScale.ts --mode cp-ws --n 1000   # real sockets, to a CSMS in another process
//   bun scripts/bench/engineScale.ts --suite            # the table, one process per row
//
// mode bare: N async behavior loops on a VirtualClock with an in-memory
//   transport (a function that answers after a promise job). No ChargePoint.
// mode cp:   N real ChargePoint instances (engine, handlers, connectors, state
//   manager, logger with every type off), each with the same small behavior
//   loaded, talking over an in-memory WebSocket to an in-process 1.6J CSMS.
//
// The memory numbers are of the JSC heap (heapSize + extraMemorySize) after a
// full GC (Bun.gc(true)), divided by N; RSS is the process's. The in-memory socket is lighter than a real
// WebSocket, which is not included.
import { heapStats } from "bun:jsc";
import path from "node:path";
import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";
import { ChargePoint } from "../../packages/core/src/cp/domain/charge-point/ChargePoint.ts";
import {
  VirtualClock,
  type SimClock,
} from "../../packages/core/src/cp/shared/clock.ts";
import { RngStreams } from "../../packages/core/src/cp/shared/rng.ts";

const HOUR_MS = 3_600_000;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

interface Row {
  mode: string;
  n: number;
  hours: number;
  setupMs: number;
  bootMs: number;
  runMs: number;
  messages: number;
  timers: number;
  heapBaselineMB: number;
  heapAfterSetupMB: number;
  heapAfterRunMB: number;
  heapPerChargerKB: number;
  heapPerChargerAfterRunKB: number;
  rssBaselineMB: number;
  rssPeakMB: number;
  rssEndMB: number;
  rssPerChargerKB: number;
}

const mb = (bytes: number): number => Math.round((bytes / 1048576) * 10) / 10;
const kb = (bytes: number): number => Math.round((bytes / 1024) * 10) / 10;

function measure(): { heap: number; rss: number } {
  Bun.gc(true);
  Bun.gc(true);
  // process.memoryUsage().heapUsed does not follow the JSC heap in Bun.
  const h = heapStats();
  return {
    heap: h.heapSize + h.extraMemorySize,
    rss: process.memoryUsage().rss,
  };
}

// ---- the small behavior ---------------------------------------------------

/** Every 30-90 virtual seconds a Heartbeat through the normal path; every 10th
 *  is raced against a deadline (`until`), like a behavior that waits for a CSMS. */
const loop: Behavior = {
  api: 1,
  id: "scale-loop",
  async main(ctx) {
    const draws = ctx.random("loop");
    let n = 0;
    while (!ctx.stopping) {
      await ctx.sleep(draws.int(30_000, 90_000));
      n++;
      const call = ctx.send("Heartbeat", {});
      if (n % 10 === 0) await ctx.until(call, { ms: 20_000 });
      else await call;
      ctx.state.beats = n;
    }
  },
};

// ---- mode bare ------------------------------------------------------------

async function bare(n: number, hours: number): Promise<Row> {
  const base = measure();
  const t0 = performance.now();
  const clock = new VirtualClock({ start: Date.UTC(2030, 0, 1) });
  const streams = new RngStreams("scale");
  let messages = 0;
  let stopping = false;
  // The in-memory transport: an answer after one promise job.
  const send = (): Promise<object> => {
    messages++;
    return Promise.resolve({ currentTime: "x" });
  };
  const runs: Promise<void>[] = [];
  for (let i = 0; i < n; i++) {
    const id = `CP-${i}`;
    const own: SimClock = clock.scoped(id);
    const rng = streams.stream(id, "loop");
    const state: Record<string, unknown> = {};
    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        own.setTimeout(resolve, ms);
      });
    const until = async <T>(p: Promise<T>, ms: number): Promise<T> => {
      let timer: ReturnType<SimClock["setTimeout"]> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = own.setTimeout(() => reject(new Error("timeout")), ms);
      });
      try {
        return await Promise.race([p, timeout]);
      } finally {
        if (timer !== undefined) own.clearTimeout(timer);
      }
    };
    runs.push(
      (async () => {
        let beats = 0;
        while (!stopping) {
          await sleep(rng.int(30_000, 90_001));
          beats++;
          const call = send();
          if (beats % 10 === 0) await until(call, 20_000);
          else await call;
          state.beats = beats;
        }
      })(),
    );
  }
  const setupMs = performance.now() - t0;
  const afterSetup = measure();
  let rssPeak = afterSetup.rss;
  const t1 = performance.now();
  const step = 600_000;
  for (let left = hours * HOUR_MS; left > 0; left -= step) {
    await clock.advanceBy(Math.min(step, left));
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }
  const runMs = performance.now() - t1;
  const afterRun = measure();
  stopping = true;
  return row("bare", n, hours, {
    setupMs,
    bootMs: 0,
    runMs,
    messages,
    timers: clock.fired,
    base,
    afterSetup,
    afterRun,
    rssPeak,
  });
}

// ---- mode cp --------------------------------------------------------------

/** A WebSocket that talks to an in-process 1.6J CSMS through promise jobs. */
function installFleetTransport(
  clock: VirtualClock,
  counts: { messages: number; boots: number },
): void {
  class FleetSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readyState = 0;
    readonly bufferedAmount = 0;
    readonly extensions = "";
    binaryType = "blob";
    readonly protocol = "ocpp1.6";
    constructor(readonly url: string) {
      super();
      void Promise.resolve().then(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }
    send(data: string): void {
      counts.messages++;
      const frame = JSON.parse(data) as [number, string, string, unknown];
      if (frame[0] !== 2) return; // an answer to a CSMS call: none are sent
      const action = frame[2];
      let payload: Record<string, unknown> = {};
      if (action === "BootNotification") {
        counts.boots++;
        payload = {
          status: "Accepted",
          currentTime: new Date(clock.now()).toISOString(),
          interval: 300,
        };
      } else if (action === "Heartbeat") {
        payload = { currentTime: new Date(clock.now()).toISOString() };
      }
      void Promise.resolve().then(() => {
        if (this.readyState !== 1) return;
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify([3, frame[1], payload]),
          }),
        );
      });
    }
    ping(): void {}
    close(): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      void Promise.resolve().then(() =>
        this.dispatchEvent(new CloseEvent("close", { code: 1000 })),
      );
    }
  }
  Object.assign(FleetSocket, {});
  globalThis.WebSocket = FleetSocket as unknown as typeof WebSocket;
}

async function withChargePoints(
  n: number,
  hours: number,
  realSockets: boolean,
): Promise<Row> {
  const base = measure();
  let t0 = performance.now();
  const clock = new VirtualClock({ start: Date.UTC(2030, 0, 1) });
  const counts = { messages: 0, boots: 0 };
  let csmsProc: ReturnType<typeof Bun.spawn> | undefined;
  let wsUrl = "ws://fleet.invalid";
  let connectedAt = (): number => counts.boots;
  if (realSockets) {
    // A real WebSocket per charge point to a CSMS in another process.
    const port = 9300 + Math.floor(Math.random() * 500);
    csmsProc = Bun.spawn(
      [
        "bun",
        path.join(import.meta.dir, "../verify/fakeCsms16.ts"),
        "--port",
        String(port),
        "--no-frames",
        "--report",
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    let connected = 0;
    void (async () => {
      const reader = (
        csmsProc.stdout as ReadableStream<Uint8Array>
      ).getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        const m = /connected (\d+)/g;
        for (const hit of decoder.decode(value).matchAll(m)) {
          connected = Number(hit[1]);
        }
      }
    })();
    wsUrl = `ws://127.0.0.1:${port}`;
    connectedAt = () => connected;
    await Bun.sleep(1000);
    t0 = performance.now();
  } else {
    installFleetTransport(clock, counts);
  }
  const cps: ChargePoint[] = [];
  for (let i = 0; i < n; i++) {
    const id = `CP-${i}`;
    const cp = new ChargePoint(
      id,
      {
        chargePointVendor: "ocpp-cp-simulator",
        chargePointModel: "scale",
      },
      1,
      wsUrl,
      null,
      null,
      null,
      {},
      [],
      "OCPP-1.6J",
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      { clock: clock.scoped(id), seed: "scale" },
    );
    cp.logger.setEnabledTypes();
    cp.events.on("error", () => undefined);
    cps.push(cp);
  }
  const setupMs = performance.now() - t0;
  const afterConstruct = measure();
  let rssPeak = afterConstruct.rss;

  const t1 = performance.now();
  for (const cp of cps) cp.connect();
  if (realSockets) {
    // Real I/O: wait (real time) until the CSMS holds every connection.
    const until = Date.now() + 120_000;
    while (connectedAt() < n && Date.now() < until) await Bun.sleep(100);
    await Bun.sleep(1500);
  }
  // Boot, the status cascade and the first timers settle in virtual seconds.
  await clock.advanceBy(5_000);
  const bootMs = performance.now() - t1;
  if (connectedAt() !== n) {
    throw new Error(`only ${connectedAt()} of ${n} charge points connected`);
  }
  for (const cp of cps) cp.loadBehavior(loop);
  const afterSetup = measure();
  rssPeak = Math.max(rssPeak, afterSetup.rss);

  const t2 = performance.now();
  const step = 600_000;
  for (let left = hours * HOUR_MS; left > 0; left -= step) {
    await clock.advanceBy(Math.min(step, left));
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }
  const runMs = performance.now() - t2;
  const afterRun = measure();
  const result = row(realSockets ? "cp-ws" : "cp", n, hours, {
    setupMs,
    bootMs,
    runMs,
    messages: counts.messages,
    timers: clock.fired,
    base,
    afterSetup: afterSetup,
    afterRun,
    rssPeak,
    afterConstruct,
  });
  for (const cp of cps) cp.dispose();
  csmsProc?.kill();
  return result;
}

function row(
  mode: string,
  n: number,
  hours: number,
  m: {
    setupMs: number;
    bootMs: number;
    runMs: number;
    messages: number;
    timers: number;
    base: { heap: number; rss: number };
    afterSetup: { heap: number; rss: number };
    afterRun: { heap: number; rss: number };
    rssPeak: number;
    afterConstruct?: { heap: number; rss: number };
  },
): Row {
  return {
    mode,
    n,
    hours,
    setupMs: Math.round(m.setupMs),
    bootMs: Math.round(m.bootMs),
    runMs: Math.round(m.runMs),
    messages: m.messages,
    timers: m.timers,
    heapBaselineMB: mb(m.base.heap),
    heapAfterSetupMB: mb(m.afterSetup.heap),
    heapAfterRunMB: mb(m.afterRun.heap),
    heapPerChargerKB: kb((m.afterSetup.heap - m.base.heap) / n),
    heapPerChargerAfterRunKB: kb((m.afterRun.heap - m.base.heap) / n),
    rssBaselineMB: mb(m.base.rss),
    rssPeakMB: mb(m.rssPeak),
    rssEndMB: mb(m.afterRun.rss),
    rssPerChargerKB: kb((m.afterRun.rss - m.base.rss) / n),
  };
}

// ---- main -----------------------------------------------------------------

if (process.argv.includes("--suite")) {
  const rows: Row[] = [];
  const plan: Array<[string, number]> = [
    ["bare", 1000],
    ["bare", 10000],
    ["cp", 1000],
    ["cp", 2000],
    ["cp", 5000],
    ["cp", 10000],
    ["cp-ws", 1000],
  ];
  const only = arg("--only", "");
  for (const [mode, n] of plan) {
    if (only && !only.split(",").includes(`${mode}:${n}`)) continue;
    const proc = Bun.spawn(
      [
        "bun",
        import.meta.path,
        "--mode",
        mode,
        "--n",
        String(n),
        "--hours",
        arg("--hours", "1"),
        "--json",
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) {
      console.log(`${mode}:${n} failed with exit ${code}`);
      continue;
    }
    rows.push(JSON.parse(text.trim().split("\n").pop() as string) as Row);
  }
  console.table(rows);
  console.log(JSON.stringify(rows));
} else {
  const mode = arg("--mode", "bare");
  const n = Number(arg("--n", "1000"));
  const hours = Number(arg("--hours", "1"));
  const result =
    mode === "cp" || mode === "cp-ws"
      ? await withChargePoints(n, hours, mode === "cp-ws")
      : await bare(n, hours);
  console.log(JSON.stringify(result));
  process.exit(0);
}
