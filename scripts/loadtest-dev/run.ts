#!/usr/bin/env bun
// Dev spike-test runner: a faithful OCPP 1.6J fleet on top of the simulator's
// server-mode daemons, driven over their Socket.IO control plane.
// See scripts/loadtest-dev/README.md for the commands and the output files.
import { spawn, type Subprocess } from "bun";
import { parseArgs } from "node:util";
import { lookup } from "node:dns/promises";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { io, type Socket } from "socket.io-client";

// ---------------------------------------------------------------- arguments
const { values: a } = parseArgs({
  options: {
    url: {
      type: "string",
      default: "wss://cs.dev-dmm-ev-charge.com/chargepoint/",
    },
    "first-id": { type: "string", default: "790001" },
    count: { type: "string", default: "4000" },
    connectors: { type: "string", default: "2" },
    "per-daemon": { type: "string", default: "1000" },
    "ramp-start": { type: "string" },
    "ramp-sec": { type: "string", default: "300" },
    "observe-until": { type: "string" },
    "client-storm-at": { type: "string" },
    "mute-ratio": { type: "string", default: "0.15" },
    "aggressive-ratio": { type: "string", default: "0.10" },
    "flappy-ratio": { type: "string", default: "0.10" },
    "flap-count": { type: "string", default: "2" },
    "flap-after-ms": { type: "string", default: "2000" },
    "hb-window": { type: "string", default: "65" },
    "base-port": { type: "string", default: "9710" },
    "rpc-conns": { type: "string", default: "4" },
    "rpc-rate": { type: "string", default: "80" },
    "incident-min-closes": { type: "string", default: "20" },
    vendor: { type: "string", default: "LoadTest" },
    model: { type: "string", default: "SpikeSim" },
    "tls-ca": { type: "string" },
    seed: { type: "string", default: "1" },
    out: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (a.help || !a["ramp-start"] || !a["observe-until"] || !a.out) {
  console.log(`usage: bun scripts/loadtest-dev/run.ts --ramp-start <epoch s> --observe-until <epoch s> --out DIR
  [--url wss://cs.dev-dmm-ev-charge.com/chargepoint/] [--first-id 790001] [--count 4000] [--connectors 2]
  [--ramp-sec 300] [--client-storm-at <epoch s>] [--per-daemon 1000] [--mute-ratio 0.15]
  [--aggressive-ratio 0.10] [--flappy-ratio 0.10] [--hb-window 65] [--base-port 9710] [--tls-ca pem] [--dry-run]`);
  process.exit(a.help ? 0 : 2);
}
const num = (k: keyof typeof a): number => {
  const v = Number(a[k]);
  if (!Number.isFinite(v))
    throw new Error(`--${k} must be a number, got ${a[k]}`);
  return v;
};
const URL_BASE = a.url!.endsWith("/") ? a.url! : `${a.url}/`;
const FIRST_ID = num("first-id");
const COUNT = num("count");
const CONNECTORS = num("connectors");
const PER_DAEMON = num("per-daemon");
const RAMP_START = num("ramp-start") * 1000;
const RAMP_MS = num("ramp-sec") * 1000;
const RAMP_END = RAMP_START + RAMP_MS;
const OBSERVE_UNTIL = num("observe-until") * 1000;
const STORM_AT = a["client-storm-at"] ? num("client-storm-at") * 1000 : null;
const MUTE = num("mute-ratio");
const AGGR = num("aggressive-ratio");
const FLAPPY = num("flappy-ratio");
const FLAP_COUNT = num("flap-count");
const FLAP_AFTER = num("flap-after-ms");
const WIN_MS = num("hb-window") * 1000;
const BASE_PORT = num("base-port");
const RPC_CONNS = num("rpc-conns");
const RPC_RATE = num("rpc-rate");
const MIN_CLOSES = num("incident-min-closes");
const SEED = num("seed");
const OUT = resolve(a.out!);
const REPO = resolve(import.meta.dir, "../..");
const BEHAVIOR_FILE = join(import.meta.dir, "mute.behavior.ts");
const DROP_RULE = "loadtest-drop";
const RPC_MAX_INFLIGHT = 48; // daemon cap is 64 per connection
if (OBSERVE_UNTIL <= RAMP_END)
  throw new Error("--observe-until must be after ramp end");
if (STORM_AT !== null && (STORM_AT < RAMP_END || STORM_AT >= OBSERVE_UNTIL))
  throw new Error(
    "--client-storm-at must be between ramp end and --observe-until",
  );
mkdirSync(OUT, { recursive: true });

const iso = (ms: number): string => new Date(ms).toISOString();
const runnerLog = join(OUT, "runner.log");
function say(line: string): void {
  const l = `${iso(Date.now())} ${line}`;
  console.log(l);
  appendFileSync(runnerLog, `${l}\n`);
}
function jsonl(file: string, obj: unknown): void {
  appendFileSync(join(OUT, file), `${JSON.stringify(obj)}\n`);
}

// ------------------------------------------------------------- fleet plan
type Profile = "normal" | "aggressive" | "flappy";
const RECONNECT: Record<Profile, Record<string, unknown>> = {
  // Built-in reconnect loop. Retry every 3.6 s.
  aggressive: {
    mode: "fixed",
    baseDelayMs: 3600,
    jitterMs: 0,
    maxAttempts: -1,
  },
  flappy: { mode: "fixed", baseDelayMs: 3600, jitterMs: 0, maxAttempts: -1 },
  // exponential 2.5 s -> capped 5 s, + seeded jitter 0..20 s:
  // first redial 2.5-22.5 s (mean 12.5 s, as for 0-25 s), then every 5-25 s.
  normal: {
    mode: "exponential",
    baseDelayMs: 2500,
    maxDelayMs: 5000,
    jitterMs: 20000,
    maxAttempts: -1,
  },
};
const frac = (x: number): number => x - Math.floor(x);
const ids: string[] = [];
const idx = new Map<string, number>();
const isMute = new Uint8Array(COUNT);
const profile: Profile[] = [];
const daemonOf = new Uint16Array(COUNT);
const DAEMONS = Math.max(1, Math.ceil(COUNT / PER_DAEMON));
for (let i = 0; i < COUNT; i++) {
  const id = String(FIRST_ID + i);
  ids.push(id);
  idx.set(id, i);
  // Low-discrepancy sequences: classes spread evenly over the id range and
  // (nearly) independent of each other.
  const u = frac((i + 0.5) * 0.6180339887498949);
  const v = frac((i + 0.5) * 0.7548776662466927 + 0.31);
  profile.push(
    u < FLAPPY ? "flappy" : u < FLAPPY + AGGR ? "aggressive" : "normal",
  );
  isMute[i] = v < MUTE ? 1 : 0;
  daemonOf[i] = i % DAEMONS;
}
const nonMuteCount = COUNT - isMute.reduce((s, x) => s + x, 0);
// Ramp order: a seeded shuffle, one connect every RAMP_MS / COUNT.
let rs = SEED >>> 0 || 1;
const rand = (): number => {
  rs ^= rs << 13;
  rs >>>= 0;
  rs ^= rs >>> 17;
  rs ^= rs << 5;
  rs >>>= 0;
  return rs / 4294967296;
};
const order = Array.from({ length: COUNT }, (_, i) => i);
for (let i = COUNT - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [order[i], order[j]] = [order[j]!, order[i]!];
}
const classCounts: Record<string, number> = {};
for (let i = 0; i < COUNT; i++) {
  const k = `${profile[i]}${isMute[i] ? "+mute" : ""}`;
  classCounts[k] = (classCounts[k] ?? 0) + 1;
}
const plan = {
  url: URL_BASE,
  ids: `${ids[0]}..${ids[COUNT - 1]}`,
  count: COUNT,
  connectors: CONNECTORS,
  daemons: DAEMONS,
  rampStart: iso(RAMP_START),
  rampEnd: iso(RAMP_END),
  clientStormAt: STORM_AT ? iso(STORM_AT) : null,
  observeUntil: iso(OBSERVE_UNTIL),
  mute: COUNT - nonMuteCount,
  classes: classCounts,
  reconnect: RECONNECT,
  hbWindowSec: WIN_MS / 1000,
  muteIdsSample: ids.filter((_, i) => isMute[i]).slice(0, 10),
};
writeFileSync(join(OUT, "plan.json"), JSON.stringify(plan, null, 2));
say(`PLAN ${JSON.stringify(plan)}`);
if (a["dry-run"]) process.exit(0);
if (RAMP_START < Date.now())
  say(
    `WARN ramp start is ${((Date.now() - RAMP_START) / 1000).toFixed(0)} s in the past: the late part of the ramp is compressed`,
  );

// --------------------------------------------------------------- daemons
interface Daemon {
  k: number;
  port: number;
  proc: Subprocess;
  pid: number;
  trace: string;
  exited: boolean;
  rpc: RpcPool;
  events?: Socket;
  traceOff: number;
  tracePartial: string;
  lastCpu?: { t: number; ticks: number };
}
const daemons: Daemon[] = [];
function startDaemon(k: number): Daemon {
  const port = BASE_PORT + k;
  const trace = join(OUT, `trace-d${k}.jsonl`);
  const log = join(OUT, `daemon-d${k}.log`);
  const cmd = [
    "bun",
    "apps/cli/src/main.ts",
    "--http-port",
    String(port),
    "--metrics-no-auth",
    "--behavior",
    BEHAVIOR_FILE,
    "--allow-behavior-code",
    "--trace-output",
    trace,
    "--log-level",
    "warn",
  ];
  const quoted = cmd.map((c) => `'${c.replace(/'/g, "'\\''")}'`).join(" ");
  const proc = spawn(
    [
      "bash",
      "-c",
      `ulimit -n 65536 2>/dev/null || ulimit -n "$(ulimit -Hn)"; echo "nofile=$(ulimit -n)"; exec ${quoted}`,
    ],
    {
      cwd: REPO,
      stdout: Bun.file(log),
      stderr: Bun.file(`${log}.err`),
      stdin: "ignore",
    },
  );
  const d: Daemon = {
    k,
    port,
    proc,
    pid: proc.pid,
    trace,
    exited: false,
    rpc: new RpcPool(k, port),
    traceOff: 0,
    tracePartial: "",
  };
  void proc.exited.then((code) => {
    d.exited = true;
    if (!stopping)
      say(`DAEMON_EXIT d${k} pid=${d.pid} code=${code} (unexpected)`);
  });
  return d;
}
async function waitHealthy(d: Daemon): Promise<void> {
  for (let n = 0; n < 300; n++) {
    try {
      const r = await fetch(`http://127.0.0.1:${d.port}/v1/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    if (d.exited)
      throw new Error(
        `daemon d${d.k} exited during start, see ${OUT}/daemon-d${d.k}.log*`,
      );
    await Bun.sleep(200);
  }
  throw new Error(`daemon d${d.k} not healthy after 60 s`);
}

// ------------------------------------------------------- control plane RPC
interface Ack {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message?: string };
}
interface Job {
  method: string;
  params: unknown;
  cpId?: string;
  resolve: (ack: Ack) => void;
}
class RpcPool {
  conns: { s: Socket; inFlight: number; tokens: number; last: number }[] = [];
  queue: Job[] = [];
  done = 0;
  failed = 0;
  constructor(
    readonly k: number,
    readonly port: number,
  ) {}
  async open(): Promise<void> {
    for (let c = 0; c < RPC_CONNS; c++) {
      const s = io(`http://127.0.0.1:${this.port}`, {
        path: "/socket.io/",
        transports: ["websocket"],
      });
      await new Promise<void>((res, rej) => {
        s.once("connect", () => res());
        s.once("connect_error", rej);
      });
      this.conns.push({
        s,
        inFlight: 0,
        tokens: Math.min(RPC_RATE, 40),
        last: Date.now(),
      });
    }
  }
  call(method: string, params: unknown, cpId?: string): Promise<Ack> {
    return new Promise((res) => {
      this.queue.push({ method, params, cpId, resolve: res });
      this.pump();
    });
  }
  pump(): void {
    const now = Date.now();
    for (const c of this.conns) {
      c.tokens = Math.min(40, c.tokens + ((now - c.last) / 1000) * RPC_RATE);
      c.last = now;
      while (
        this.queue.length &&
        c.inFlight < RPC_MAX_INFLIGHT &&
        c.tokens >= 1 &&
        c.s.connected
      ) {
        const job = this.queue.shift()!;
        c.tokens -= 1;
        c.inFlight++;
        c.s
          .timeout(45_000)
          .emitWithAck("rpc", {
            method: job.method,
            params: job.params,
            cpId: job.cpId,
          })
          .then(
            (ack: Ack) => ack,
            (): Ack => ({ ok: false, error: { code: "client_timeout" } }),
          )
          .then((ack: Ack) => {
            c.inFlight--;
            this.done++;
            if (!ack.ok) this.failed++;
            job.resolve(ack);
            this.pump();
          });
      }
    }
  }
  close(): void {
    for (const c of this.conns) c.s.close();
  }
}

// ------------------------------------------------------------- fleet state
const open = new Uint8Array(COUNT);
const bootedAt = new Float64Array(COUNT); // last Accepted boot on the current socket, 0 = none
const everBooted = new Uint8Array(COUNT);
const created = new Uint8Array(COUNT);
const expectDrop = new Uint8Array(COUNT);
const flapsLeft = new Int8Array(COUNT);
let openCount = 0;
let bootedCount = 0;
const closeReasons = new Map<string, { server: number; client: number }>();
const errorMsgs = new Map<string, number>();
const hbIntervals = new Map<number, number>();
let alreadyExists = 0;

interface Incident {
  n: number;
  kind: "server-restart" | "client-storm";
  t0: number;
  confirmedAt?: number;
  openBefore: number;
  serverCloses: number;
  clientCloses: number;
  /** Dials that never opened (1006 "Failed to connect"). */
  failedDials: number;
  closes: Record<string, number>;
  minOpen: number;
  minBooted: number;
  milestones: Record<string, number | null>; // seconds from t0
  end?: number;
}
const incidents: Incident[] = [];
let candidate: {
  t0: number;
  closes: number;
  openBefore: number;
  reasons: Record<string, number>;
} | null = null;
const MILESTONES = [0.5, 0.9, 0.95, 0.99, 1.0];

function currentIncident(): Incident | undefined {
  return incidents[incidents.length - 1];
}
function onClose(i: number, code: number, reason: string, t: number): void {
  const key = `${code} ${reason || "-"}`;
  const byRunner = expectDrop[i] === 1;
  expectDrop[i] = 0;
  const e = closeReasons.get(key) ?? { server: 0, client: 0 };
  if (byRunner) e.client++;
  else e.server++;
  closeReasons.set(key, e);
  if (/already exists/i.test(reason)) alreadyExists++;
  jsonl("closes.jsonl", {
    t: iso(t),
    cpId: ids[i],
    code,
    reason,
    by: byRunner ? "runner" : "server",
  });
  const cur = currentIncident();
  if (cur && cur.end === undefined) {
    if (byRunner) cur.clientCloses++;
    else if (/failed to connect/i.test(reason)) cur.failedDials++;
    else cur.serverCloses++;
    cur.closes[key] = (cur.closes[key] ?? 0) + 1;
  }
  // A dial that never opened is reported as a 1006 "Failed to connect"
  // disconnect: count it, but it is not a close of a live socket.
  if (byRunner || t < RAMP_END || /failed to connect/i.test(reason)) return;
  // A server close outside a fresh incident: candidate for a restart.
  if (cur && cur.end === undefined && t - cur.t0 < 60_000) return;
  if (!candidate)
    candidate = { t0: t, closes: 0, openBefore: openCount + 1, reasons: {} };
  candidate.closes++;
  candidate.reasons[key] = (candidate.reasons[key] ?? 0) + 1;
  const need = Math.max(MIN_CLOSES, Math.ceil(candidate.openBefore * 0.05));
  if (candidate.closes >= need) {
    const inc = newIncident(
      "server-restart",
      candidate.t0,
      candidate.openBefore,
    );
    inc.confirmedAt = t;
    inc.serverCloses = candidate.closes;
    inc.closes = { ...candidate.reasons };
    say(
      `FIRST_CLOSE ${iso(candidate.t0)} (incident #${inc.n}: ${candidate.closes} server closes by +${((t - candidate.t0) / 1000).toFixed(2)} s, ${Object.entries(
        candidate.reasons,
      )
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")})`,
    );
    candidate = null;
  }
}
function newIncident(
  kind: Incident["kind"],
  t0: number,
  openBefore: number,
): Incident {
  const prev = currentIncident();
  if (prev && prev.end === undefined) prev.end = t0;
  const inc: Incident = {
    n: incidents.length + 1,
    kind,
    t0,
    openBefore,
    serverCloses: 0,
    clientCloses: 0,
    failedDials: 0,
    closes: {},
    minOpen: openCount,
    minBooted: bootedCount,
    milestones: {},
  };
  for (const m of MILESTONES) {
    inc.milestones[`open${m * 100}`] = null;
    inc.milestones[`booted${m * 100}`] = null;
  }
  incidents.push(inc);
  for (let i = 0; i < COUNT; i++)
    flapsLeft[i] = profile[i] === "flappy" ? FLAP_COUNT : 0;
  return inc;
}
function onEvent(
  d: Daemon,
  env: {
    kind: string;
    cpId?: string;
    evt?: { event: string; data?: Record<string, unknown>; timestamp?: string };
  },
): void {
  if (env.kind !== "cp" || !env.evt || env.cpId === undefined) return;
  const ev = env.evt.event;
  if (
    ev !== "connected" &&
    ev !== "disconnected" &&
    ev !== "boot_notification" &&
    ev !== "error"
  )
    return;
  const i = idx.get(env.cpId);
  if (i === undefined) return;
  const t = env.evt.timestamp ? Date.parse(env.evt.timestamp) : Date.now();
  const data = env.evt.data ?? {};
  if (ev === "connected") {
    if (!open[i]) {
      open[i] = 1;
      openCount++;
    }
  } else if (ev === "disconnected") {
    if (open[i]) {
      open[i] = 0;
      openCount--;
    }
    if (bootedAt[i]) {
      bootedAt[i] = 0;
      bootedCount--;
    }
    onClose(i, Number(data.code ?? 0), String(data.reason ?? ""), t);
  } else if (ev === "boot_notification") {
    if (data.status === "Accepted" && open[i]) {
      if (!bootedAt[i]) bootedCount++;
      bootedAt[i] = t;
      everBooted[i] = 1;
      const iv = Number(data.interval);
      hbIntervals.set(iv, (hbIntervals.get(iv) ?? 0) + 1);
      const cur = currentIncident();
      if (cur && cur.end === undefined && t > cur.t0 && flapsLeft[i] > 0) {
        flapsLeft[i]--;
        setTimeout(() => {
          if (stopping || !open[i]) return;
          expectDrop[i] = 1;
          void d.rpc
            .call("network_sim.disconnect.trigger", {
              cpId: ids[i],
              ruleId: DROP_RULE,
            })
            .then((ack) => {
              if (!ack.ok) expectDrop[i] = 0;
            });
        }, FLAP_AFTER);
      }
    }
  } else if (ev === "error") {
    const msg = String(data.error ?? "")
      .replace(/\d{6,}/g, "<id>")
      .slice(0, 160);
    if (msg) errorMsgs.set(msg, (errorMsgs.get(msg) ?? 0) + 1);
  }
}

// ------------------------------------------------------------- trace tail
interface Sample {
  t: number;
  action: string;
  rtt: number;
}
const rtts: Sample[] = [];
const noAnswer: { t: number; action: string }[] = [];
const pendingOut = new Map<string, { t: number; action: string }>();
const pendingCs = new Map<string, { t: number; action: string }>();
const csCalls = new Uint32Array(COUNT);
const csAnswered = new Uint32Array(COUNT);
const csActions = new Map<string, { calls: number; answered: number }>();
const hbOk = new Map<number, Uint8Array>();
let traceLines = 0;
function tailTraces(): void {
  for (const d of daemons) {
    if (!existsSync(d.trace)) continue;
    const size = statSync(d.trace).size;
    if (size <= d.traceOff) continue;
    const fd = openSync(d.trace, "r");
    const len = Math.min(size - d.traceOff, 64 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, d.traceOff);
    closeSync(fd);
    d.traceOff += len;
    const text = d.tracePartial + buf.toString("utf8");
    const lines = text.split("\n");
    d.tracePartial = lines.pop() ?? "";
    for (const line of lines) if (line) onTrace(line);
  }
}
function onTrace(line: string): void {
  let r: {
    chargePointId?: string;
    direction: string;
    messageType: string;
    messageId?: string;
    action?: string;
    timestamp: string;
  };
  try {
    r = JSON.parse(line);
  } catch {
    return;
  }
  traceLines++;
  const cp = r.chargePointId;
  if (!cp || !r.messageId) return;
  const i = idx.get(cp);
  if (i === undefined) return;
  const t = Date.parse(r.timestamp);
  const key = `${cp}|${r.messageId}`;
  const fromCp = r.direction === "cp-to-csms";
  if (r.messageType === "CALL") {
    if (fromCp) pendingOut.set(key, { t, action: r.action ?? "?" });
    else {
      pendingCs.set(key, { t, action: r.action ?? "?" });
      csCalls[i]++;
      const s = csActions.get(r.action ?? "?") ?? { calls: 0, answered: 0 };
      s.calls++;
      csActions.set(r.action ?? "?", s);
    }
    return;
  }
  if (fromCp) {
    const p = pendingCs.get(key);
    if (p) {
      pendingCs.delete(key);
      csAnswered[i]++;
      csActions.get(p.action)!.answered++;
    }
    return;
  }
  const p = pendingOut.get(key);
  if (!p) return;
  pendingOut.delete(key);
  if (r.messageType === "CALLRESULT")
    rtts.push({ t: p.t, action: p.action, rtt: t - p.t });
  if (
    p.action === "Heartbeat" &&
    r.messageType === "CALLRESULT" &&
    !isMute[i] &&
    t >= RAMP_END
  ) {
    const w = Math.floor((t - RAMP_END) / WIN_MS);
    let arr = hbOk.get(w);
    if (!arr) hbOk.set(w, (arr = new Uint8Array(COUNT)));
    arr[i] = 1;
  }
}
function sweepPending(now: number): void {
  for (const [k, p] of pendingOut) {
    if (now - p.t > 65_000) {
      noAnswer.push(p);
      pendingOut.delete(k);
    }
  }
  for (const [k, p] of pendingCs) if (now - p.t > 120_000) pendingCs.delete(k);
}

// ------------------------------------------------------- heartbeat windows
let nextWindow = 0;
const windows: unknown[] = [];
function evalWindows(now: number, final = false): void {
  for (;;) {
    const start = RAMP_END + nextWindow * WIN_MS;
    const end = start + WIN_MS;
    if (end > OBSERVE_UNTIL) return;
    if (!final && now < end + 5000) return;
    const ok = hbOk.get(nextWindow) ?? new Uint8Array(COUNT);
    const prev = hbOk.get(nextWindow - 1);
    let okN = 0;
    let miss2 = 0;
    for (let i = 0; i < COUNT; i++) {
      if (isMute[i]) continue;
      if (ok[i]) okN++;
      else if (nextWindow > 0 && prev && !prev[i]) miss2++;
      else if (nextWindow > 0 && !prev) miss2++;
    }
    const inc = incidents.filter((x) => x.t0 < end).pop();
    const w = {
      w: nextWindow,
      start: iso(start),
      end: iso(end),
      hbOk: okN,
      nonMute: nonMuteCount,
      hbOkPct: +((100 * okN) / nonMuteCount).toFixed(2),
      missed2Consecutive: miss2,
      incident: inc
        ? inc.t0 > start
          ? `#${inc.n} starts in this window`
          : `#${inc.n} +${((start - inc.t0) / 1000).toFixed(0)}s`
        : null,
    };
    windows.push(w);
    jsonl("windows.jsonl", w);
    say(
      `WINDOW w${w.w} ${w.start.slice(11, 19)}-${w.end.slice(11, 19)} hb_ok=${w.hbOkPct}% (${okN}/${nonMuteCount}) missed_2_in_a_row=${miss2}${w.incident ? ` incident ${w.incident}` : ""}`,
    );
    hbOk.delete(nextWindow - 2);
    nextWindow++;
  }
}

// ------------------------------------------------------- process sampling
const TICKS = 100;
let lastRunnerCpu = {
  t: Date.now(),
  us: process.cpuUsage().user + process.cpuUsage().system,
};
function procStat(pid: number): { ticks: number; rssMb: number } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(f[11]) + Number(f[12]);
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const rss = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) / 1024;
    return { ticks, rssMb: rss };
  } catch {
    return null;
  }
}
function phaseAt(t: number): string {
  if (t < RAMP_START) return "setup";
  if (t < RAMP_END) return "ramp";
  const inc = incidents.filter((x) => x.t0 <= t).pop();
  return inc ? `incident${inc.n}` : "steady";
}
const samples: {
  t: number;
  phase: string;
  daemons: { cpu: number; rssMb: number }[];
}[] = [];
function sample(now: number): void {
  const ds = daemons.map((d) => {
    const s = procStat(d.pid);
    if (!s) return { cpu: 0, rssMb: 0 };
    const cpu = d.lastCpu
      ? ((s.ticks - d.lastCpu.ticks) / TICKS / ((now - d.lastCpu.t) / 1000)) *
        100
      : 0;
    d.lastCpu = { t: now, ticks: s.ticks };
    return { cpu: +cpu.toFixed(1), rssMb: +s.rssMb.toFixed(0) };
  });
  const cu = process.cpuUsage();
  const us = cu.user + cu.system;
  const runnerCpu =
    ((us - lastRunnerCpu.us) / 1e6 / ((now - lastRunnerCpu.t) / 1000)) * 100;
  lastRunnerCpu = { t: now, us };
  let memAvail = 0;
  try {
    memAvail =
      Number(
        /MemAvailable:\s+(\d+)/.exec(
          readFileSync("/proc/meminfo", "utf8"),
        )?.[1] ?? 0,
      ) / 1024;
  } catch {
    /* non-Linux */
  }
  const load = existsSync("/proc/loadavg")
    ? readFileSync("/proc/loadavg", "utf8").split(" ")[0]
    : "?";
  const phase = phaseAt(now);
  const row = {
    t: iso(now),
    phase,
    open: openCount,
    booted: bootedCount,
    everBooted: everBooted.reduce((s, x) => s + x, 0),
    daemons: ds,
    daemonCpuPct: +ds.reduce((s, x) => s + x.cpu, 0).toFixed(1),
    daemonRssMb: ds.reduce((s, x) => s + x.rssMb, 0),
    runnerCpuPct: +runnerCpu.toFixed(1),
    runnerRssMb: Math.round(process.memoryUsage().rss / 1048576),
    memAvailMb: Math.round(memAvail),
    load1: load,
    rpcQueue: daemons.reduce((s, d) => s + d.rpc.queue.length, 0),
  };
  samples.push({ t: now, phase, daemons: ds });
  jsonl("samples.jsonl", row);
  return void row;
}
let lastPrint = 0;
function printStatus(now: number): void {
  const last = samples[samples.length - 1];
  const cpu = last ? last.daemons.map((d) => d.cpu).join("/") : "";
  const rss = last ? last.daemons.map((d) => d.rssMb).join("/") : "";
  say(
    `STATUS ${phaseAt(now)} open=${openCount} booted=${bootedCount}/${COUNT} cpu%=${cpu} rssMB=${rss} rpcQ=${daemons.reduce((s, d) => s + d.rpc.queue.length, 0)} trace=${traceLines}`,
  );
}

// ---------------------------------------------------------- incidents tick
function incidentTick(now: number): void {
  if (candidate && now - candidate.t0 > 15_000) {
    jsonl("closes.jsonl", {
      t: iso(now),
      note: `isolated server closes (${candidate.closes}), not an incident`,
      from: iso(candidate.t0),
    });
    candidate = null;
  }
  const inc = currentIncident();
  if (!inc || inc.end !== undefined) return;
  inc.minOpen = Math.min(inc.minOpen, openCount);
  inc.minBooted = Math.min(inc.minBooted, bootedCount);
  let reBooted = 0;
  for (let i = 0; i < COUNT; i++)
    if (open[i] && bootedAt[i] >= inc.t0) reBooted++;
  const base = inc.openBefore || COUNT;
  for (const m of MILESTONES) {
    const ko = `open${m * 100}`;
    const kb = `booted${m * 100}`;
    // "open" counts sockets open now, after the incident started.
    if (
      inc.milestones[ko] === null &&
      inc.minOpen < base * m &&
      openCount >= base * m
    )
      inc.milestones[ko] = +((now - inc.t0) / 1000).toFixed(1);
    if (inc.milestones[kb] === null && reBooted >= base * m) {
      inc.milestones[kb] = +((now - inc.t0) / 1000).toFixed(1);
      if (m === 0.99)
        say(
          `RECOVERED_99 incident #${inc.n} ${inc.kind}: ${reBooted}/${base} re-booted ${inc.milestones[kb]} s after ${iso(inc.t0)}`,
        );
    }
  }
}

// ---------------------------------------------------------- stats helpers
function pct(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}
function summarize(): Record<string, unknown> {
  const phases: Record<string, Record<string, unknown>> = {};
  const by = new Map<string, number[]>();
  for (const s of rtts) {
    const k = `${phaseAt(s.t)}|${s.action}`;
    let arr = by.get(k);
    if (!arr) by.set(k, (arr = []));
    arr.push(s.rtt);
  }
  const na = new Map<string, number>();
  for (const p of noAnswer)
    na.set(
      `${phaseAt(p.t)}|${p.action}`,
      (na.get(`${phaseAt(p.t)}|${p.action}`) ?? 0) + 1,
    );
  for (const k of new Set([...by.keys(), ...na.keys()])) {
    const [phase, action] = k.split("|") as [string, string];
    if (
      !["BootNotification", "Heartbeat", "StatusNotification"].includes(action)
    )
      continue;
    const arr = (by.get(k) ?? []).sort((x, y) => x - y);
    phases[phase] ??= {};
    phases[phase]![action] = {
      n: arr.length,
      p50ms: pct(arr, 0.5),
      p95ms: pct(arr, 0.95),
      p99ms: pct(arr, 0.99),
      maxMs: arr.length ? arr[arr.length - 1] : null,
      noAnswer: na.get(k) ?? 0,
    };
  }
  const res: Record<string, Record<string, number>> = {};
  for (const s of samples) {
    s.daemons.forEach((d, k) => {
      const key = `${s.phase}|d${k}`;
      const r = (res[key] ??= { cpuMax: 0, cpuSum: 0, n: 0, rssMaxMb: 0 });
      r.cpuMax = Math.max(r.cpuMax!, d.cpu);
      r.cpuSum! += d.cpu;
      r.n!++;
      r.rssMaxMb = Math.max(r.rssMaxMb!, d.rssMb);
    });
  }
  const resources: Record<string, unknown> = {};
  for (const [k, r] of Object.entries(res))
    resources[k] = {
      cpuAvgPct: +(r.cpuSum! / r.n!).toFixed(1),
      cpuMaxPct: r.cpuMax,
      rssMaxMb: r.rssMaxMb,
    };
  const totals: Record<string, { cpuMaxPct: number; rssMaxMb: number }> = {};
  for (const s of samples) {
    const t = (totals[s.phase] ??= { cpuMaxPct: 0, rssMaxMb: 0 });
    t.cpuMaxPct = Math.max(
      t.cpuMaxPct,
      +s.daemons.reduce((x, d) => x + d.cpu, 0).toFixed(1),
    );
    t.rssMaxMb = Math.max(
      t.rssMaxMb,
      s.daemons.reduce((x, d) => x + d.rssMb, 0),
    );
  }
  let muteCalls = 0,
    muteAnswered = 0,
    normCalls = 0,
    normAnswered = 0,
    muteWithCalls = 0,
    normWithUnanswered = 0;
  for (let i = 0; i < COUNT; i++) {
    if (isMute[i]) {
      muteCalls += csCalls[i]!;
      muteAnswered += csAnswered[i]!;
      if (csCalls[i]) muteWithCalls++;
    } else {
      normCalls += csCalls[i]!;
      normAnswered += csAnswered[i]!;
      if (csCalls[i]! > csAnswered[i]!) normWithUnanswered++;
    }
  }
  const okWins = windows as { hbOkPct: number }[];
  return {
    plan,
    endedAt: iso(Date.now()),
    connected: {
      openNow: openCount,
      bootedNow: bootedCount,
      everBooted: everBooted.reduce((s, x) => s + x, 0),
    },
    heartbeatIntervalsFromBoot: Object.fromEntries(hbIntervals),
    incidents,
    heartbeatWindows: {
      count: windows.length,
      minHbOkPct: okWins.length
        ? Math.min(...okWins.map((w) => w.hbOkPct))
        : null,
      file: "windows.jsonl",
    },
    rttByPhase: phases,
    closeReasons: Object.fromEntries(closeReasons),
    alreadyExistsCloses: alreadyExists,
    errorEventsTop: Object.fromEntries(
      [...errorMsgs.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15),
    ),
    csInitiatedCalls: {
      byAction: Object.fromEntries(csActions),
      mute: {
        chargers: COUNT - nonMuteCount,
        chargersThatGotCalls: muteWithCalls,
        calls: muteCalls,
        answered: muteAnswered,
      },
      healthy: {
        chargers: nonMuteCount,
        calls: normCalls,
        answered: normAnswered,
        chargersWithUnanswered: normWithUnanswered,
      },
    },
    resourcesByPhaseDaemon: resources,
    resourcesByPhaseTotal: totals,
    traceLines,
  };
}

// ---------------------------------------------------------------- shutdown
let stopping = false;
async function targetSockets(): Promise<{ count: number; detail: string[] }> {
  const u = new URL(URL_BASE);
  const port = Number(u.port || (u.protocol === "wss:" ? 443 : 80));
  let addrs: string[] = [];
  try {
    addrs = (await lookup(u.hostname, { all: true })).map((x) => x.address);
  } catch {
    /* resolution failed: match on port only */
  }
  const live = new Set(["01", "02", "03", "04", "05", "08", "09", "0B"]);
  const detail: string[] = [];
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n").slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length < 4) continue;
      const [ipHex, portHex] = c[2]!.split(":") as [string, string];
      if (parseInt(portHex, 16) !== port || !live.has(c[3]!)) continue;
      let ip = "";
      if (ipHex.length === 8)
        ip = [3, 2, 1, 0]
          .map((b) => parseInt(ipHex.slice(b * 2, b * 2 + 2), 16))
          .join(".");
      else if (ipHex.startsWith("0000000000000000FFFF0000")) {
        const v4 = ipHex.slice(24);
        ip = [3, 2, 1, 0]
          .map((b) => parseInt(v4.slice(b * 2, b * 2 + 2), 16))
          .join(".");
      }
      if (addrs.length && ip && !addrs.includes(ip)) continue;
      detail.push(`${ip || ipHex}:${port} st=${c[3]}`);
    }
  }
  return { count: detail.length, detail: detail.slice(0, 10) };
}
async function shutdown(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  say(`STOP ${reason}`);
  try {
    tailTraces();
    sweepPending(Date.now() + 120_000);
    evalWindows(Date.now(), true);
    for (const d of daemons) {
      try {
        const m = await (
          await fetch(`http://127.0.0.1:${d.port}/metrics`)
        ).text();
        writeFileSync(join(OUT, `metrics-d${d.k}.prom`), m);
      } catch {
        /* daemon gone */
      }
    }
  } catch (e) {
    say(`WARN final collection failed: ${String(e)}`);
  }
  const inc = currentIncident();
  if (inc && inc.end === undefined) inc.end = Date.now();
  for (const d of daemons) {
    d.rpc.close();
    d.events?.close();
    if (!d.exited) d.proc.kill("SIGTERM");
  }
  const deadline = Date.now() + 15_000;
  while (daemons.some((d) => !d.exited) && Date.now() < deadline)
    await Bun.sleep(200);
  for (const d of daemons)
    if (!d.exited) {
      say(`WARN d${d.k} did not exit after SIGTERM, SIGKILL`);
      d.proc.kill("SIGKILL");
    }
  await Bun.sleep(500);
  let sock = await targetSockets();
  for (let n = 0; n < 20 && sock.count > 0; n++) {
    await Bun.sleep(500);
    sock = await targetSockets();
  }
  const alive = daemons
    .filter((d) => existsSync(`/proc/${d.pid}`))
    .map((d) => d.pid);
  const summary = {
    ...summarize(),
    shutdown: {
      reason,
      daemonsAlive: alive,
      socketsToTarget: sock.count,
      socketDetail: sock.detail,
    },
  };
  writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  printSummary(summary);
  say(
    `END daemons_alive=${alive.length} sockets_to_target=${sock.count} out=${OUT}`,
  );
  process.exit(alive.length === 0 && sock.count === 0 ? 0 : 1);
}
function printSummary(
  s: ReturnType<typeof summarize> & { shutdown: { socketsToTarget: number } },
): void {
  const lines: string[] = ["===== SUMMARY ====="];
  lines.push(
    `fleet ${COUNT} (${COUNT - nonMuteCount} mute), daemons ${DAEMONS}, ever booted ${(s.connected as { everBooted: number }).everBooted}`,
  );
  lines.push(
    `heartbeat intervals from Boot: ${JSON.stringify(s.heartbeatIntervalsFromBoot)}`,
  );
  for (const inc of incidents) {
    lines.push(
      `incident #${inc.n} ${inc.kind} t0=${iso(inc.t0)} openBefore=${inc.openBefore} minOpen=${inc.minOpen} serverCloses=${inc.serverCloses} clientCloses=${inc.clientCloses} failedDials=${inc.failedDials} ` +
        `re-booted 50/90/99/100%: ${["booted50", "booted90", "booted99", "booted100"].map((k) => inc.milestones[k] ?? "-").join("/")} s; closes ${JSON.stringify(inc.closes)}`,
    );
  }
  const ws = windows as {
    w: number;
    hbOkPct: number;
    missed2Consecutive: number;
    incident: string | null;
  }[];
  lines.push(
    `hb windows (${WIN_MS / 1000}s): ${ws.map((w) => `w${w.w}=${w.hbOkPct}%${w.missed2Consecutive ? `(m2=${w.missed2Consecutive})` : ""}`).join(" ")}`,
  );
  for (const [ph, acts] of Object.entries(
    s.rttByPhase as Record<
      string,
      Record<
        string,
        { n: number; p50ms: number; p95ms: number; noAnswer: number }
      >
    >,
  )) {
    lines.push(
      `rtt ${ph}: ${Object.entries(acts)
        .map(
          ([k, v]) =>
            `${k} n=${v.n} p50=${v.p50ms}ms p95=${v.p95ms}ms noAns=${v.noAnswer}`,
        )
        .join(" | ")}`,
    );
  }
  lines.push(
    `close reasons: ${JSON.stringify(s.closeReasons)} (already exists: ${s.alreadyExistsCloses})`,
  );
  lines.push(`cs calls: ${JSON.stringify(s.csInitiatedCalls)}`);
  lines.push(
    `resources (sum of daemons) by phase: ${JSON.stringify(s.resourcesByPhaseTotal)}`,
  );
  lines.push(`sockets to target after stop: ${s.shutdown.socketsToTarget}`);
  for (const l of lines) say(l);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// --------------------------------------------------------------------- main
async function main(): Promise<void> {
  say(
    `starting ${DAEMONS} daemon(s) on ports ${BASE_PORT}..${BASE_PORT + DAEMONS - 1}`,
  );
  for (let k = 0; k < DAEMONS; k++) daemons.push(startDaemon(k));
  await Promise.all(daemons.map(waitHealthy));
  for (const d of daemons) {
    await d.rpc.open();
    const ev = io(`http://127.0.0.1:${d.port}`, {
      path: "/socket.io/",
      transports: ["websocket"],
    });
    await new Promise<void>((res) => ev.once("connect", () => res()));
    ev.on("event", (env) => onEvent(d, env));
    const sub = (await ev.timeout(30_000).emitWithAck("rpc", {
      method: "events.subscribe",
      params: { scope: "*" },
    })) as Ack;
    if (!sub.ok)
      throw new Error(
        `events.subscribe on d${d.k}: ${JSON.stringify(sub.error)}`,
      );
    d.events = ev;
    const ns = await d.rpc.call("network_sim.global.save", {
      config: {
        enabled: true,
        rules: {
          [DROP_RULE]: { type: "manual-disconnect", reconnectDelayMs: 0 },
        },
      },
    });
    if (!ns.ok)
      throw new Error(
        `network_sim.global.save on d${d.k}: ${JSON.stringify(ns.error)}`,
      );
  }
  say(
    `daemons up: ${daemons.map((d) => `d${d.k}:${d.port}/pid${d.pid}`).join(" ")}`,
  );

  // Main loop: everything time-driven runs from here.
  let lastSample = 0;
  let lastTail = 0;
  let lastSweep = 0;
  let lastInc = 0;
  let rampPos = 0;
  let stormDone = false;
  let rampDoneLogged = false;
  const loop = setInterval(() => {
    if (stopping) return;
    const now = Date.now();
    // ramp: connect in the shuffled order, one slot every RAMP_MS / COUNT
    while (
      rampPos < COUNT &&
      now >= RAMP_START + (RAMP_MS * rampPos) / COUNT &&
      created[order[rampPos]!]
    ) {
      const i = order[rampPos++]!;
      void daemons[daemonOf[i]!]!.rpc.call("connect", {}, ids[i]);
    }
    if (!rampDoneLogged && rampPos >= COUNT) {
      rampDoneLogged = true;
      say(`RAMP all ${COUNT} connects issued`);
    }
    if (STORM_AT !== null && !stormDone && now >= STORM_AT) {
      stormDone = true;
      const inc = newIncident("client-storm", now, openCount);
      inc.confirmedAt = now;
      let n = 0;
      for (let i = 0; i < COUNT; i++) {
        if (!open[i]) continue;
        expectDrop[i] = 1;
        n++;
        void daemons[daemonOf[i]!]!.rpc.call("network_sim.disconnect.trigger", {
          cpId: ids[i],
          ruleId: DROP_RULE,
        }).then((ack) => {
          if (!ack.ok) expectDrop[i] = 0;
        });
      }
      say(
        `CLIENT_STORM ${iso(now)} dropping ${n} open chargers (incident #${inc.n})`,
      );
    }
    if (now - lastTail >= 2000) {
      lastTail = now;
      tailTraces();
      evalWindows(now);
    }
    if (now - lastInc >= 1000) {
      lastInc = now;
      incidentTick(now);
    }
    if (now - lastSweep >= 10_000) {
      lastSweep = now;
      sweepPending(now);
    }
    if (now - lastSample >= 5000) {
      lastSample = now;
      sample(now);
    }
    if (now - lastPrint >= 15_000) {
      lastPrint = now;
      printStatus(now);
    }
    for (const d of daemons) d.rpc.pump();
    if (now >= OBSERVE_UNTIL) {
      clearInterval(loop);
      void shutdown("observe-until reached");
    }
  }, 50);

  // Create the fleet (autoConnect false), paced by the RPC pools.
  const t0 = Date.now();
  let createFailed = 0;
  const failures: string[] = [];
  await Promise.all(
    ids.map(async (cpId, i) => {
      const d = daemons[daemonOf[i]!]!;
      const params: Record<string, unknown> = {
        cpId,
        wsUrl: URL_BASE,
        ocppVersion: "OCPP-1.6J",
        connectors: CONNECTORS,
        vendor: a.vendor,
        model: a.model,
        autoConnect: false,
        behaviors: isMute[i] ? ["loadtest-mute"] : [],
        transport: { reconnect: RECONNECT[profile[i]!] },
      };
      if (a["tls-ca"]) params.tlsCaPath = resolve(a["tls-ca"]);
      const ack = await d.rpc.call("cp.create", params);
      if (!ack.ok) {
        createFailed++;
        if (failures.length < 5)
          failures.push(`${cpId}: ${JSON.stringify(ack.error)}`);
        return;
      }
      // cp.create seeds the "Essential CP Behavior" scenario on every
      // connector (plug in on connect, Preparing, wait for RemoteStart): a
      // real idle charger does not do that, so remove it.
      for (let c = 1; c <= CONNECTORS; c++) {
        const r = await d.rpc.call(
          "remove_scenario",
          { connector: c, scenarioId: `essential-cp-behavior-c${c}` },
          cpId,
        );
        if (!r.ok && failures.length < 5)
          failures.push(
            `${cpId} remove_scenario c${c}: ${JSON.stringify(r.error)}`,
          );
      }
      created[i] = 1;
    }),
  );
  say(
    `CREATED ${COUNT - createFailed}/${COUNT} in ${((Date.now() - t0) / 1000).toFixed(1)} s${failures.length ? `; first failures: ${failures.join("; ")}` : ""}`,
  );
  if (Date.now() > RAMP_START)
    say(
      `WARN fleet creation ended ${((Date.now() - RAMP_START) / 1000).toFixed(1)} s after ramp start`,
    );
  else
    say(
      `waiting ${((RAMP_START - Date.now()) / 1000).toFixed(0)} s for ramp start ${iso(RAMP_START)}`,
    );
}
main().catch((e) => {
  say(`FATAL ${e instanceof Error ? e.stack : String(e)}`);
  void shutdown("fatal error");
});
