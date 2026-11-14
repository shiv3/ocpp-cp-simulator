#!/usr/bin/env bun
// Local stand-in for the dev central system, for verifying run.ts. NOT used
// against the real target.
//
//   bun scripts/loadtest-dev/mockCsms.ts --port 9001 [--hb-interval 60]
//       [--stats out/mock-stats.json] [--tls-cert c.pem --tls-key k.pem]
//       [--duplicate reject-new|replace-old]
//
// - Accepts ws(s)://host:port/<anything>/<cpId>; answers BootNotification
//   (Accepted, interval = --hb-interval), Heartbeat, StatusNotification and
//   any other CALL at once.
// - Like the real CS, sends ChangeConfiguration(HeartbeatInterval) 1 s after
//   an accepted boot and a TriggerMessage(StatusNotification) 2 s after, and
//   counts per charge point how many of those CALLs were answered (30 s
//   timeout). The stats file is rewritten every 5 s and on exit.
// - A second socket for a connected id is refused with close 1008
//   "already exists" (--duplicate reject-new, default) or replaces the old one.
// - SIGTERM: close every socket with 1012 "service restart", write stats, exit
//   (a k8s-style restart). SIGKILL leaves the kernel to reset the sockets.
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "9001" },
    host: { type: "string", default: "127.0.0.1" },
    "hb-interval": { type: "string", default: "60" },
    stats: { type: "string" },
    "tls-cert": { type: "string" },
    "tls-key": { type: "string" },
    duplicate: { type: "string", default: "reject-new" },
  },
});

const hbInterval = Number(values["hb-interval"]);
const CS_CALL_TIMEOUT_MS = 30_000;

interface Sock {
  cpId: string;
  send(s: string): void;
  close(code?: number, reason?: string): void;
}
interface CpStats {
  connections: number;
  csCalls: number;
  answered: number;
  timedOut: number;
}
const live = new Map<string, Sock>();
const stats = new Map<string, CpStats>();
const pending = new Map<
  string,
  { cpId: string; timer: ReturnType<typeof setTimeout> }
>();
const counters = { upgrades: 0, rejectedDuplicate: 0, calls: 0, maxLive: 0 };
let seq = 0;

function st(cpId: string): CpStats {
  let s = stats.get(cpId);
  if (!s)
    stats.set(
      cpId,
      (s = { connections: 0, csCalls: 0, answered: 0, timedOut: 0 }),
    );
  return s;
}

function csCall(ws: Sock, action: string, payload: unknown): void {
  if (live.get(ws.cpId) !== ws) return;
  const id = `cs-${++seq}`;
  st(ws.cpId).csCalls++;
  const timer = setTimeout(() => {
    pending.delete(id);
    st(ws.cpId).timedOut++;
  }, CS_CALL_TIMEOUT_MS);
  pending.set(id, { cpId: ws.cpId, timer });
  ws.send(JSON.stringify([2, id, action, payload]));
}

function conf(action: string): unknown {
  const now = new Date().toISOString();
  switch (action) {
    case "BootNotification":
      return { status: "Accepted", currentTime: now, interval: hbInterval };
    case "Heartbeat":
      return { currentTime: now };
    case "Authorize":
    case "StartTransaction":
      return { idTagInfo: { status: "Accepted" }, transactionId: 1 };
    default:
      return {};
  }
}

const tls =
  values["tls-cert"] && values["tls-key"]
    ? { cert: Bun.file(values["tls-cert"]), key: Bun.file(values["tls-key"]) }
    : undefined;

const server = Bun.serve<{ cpId: string }, never>({
  port: Number(values.port),
  hostname: values.host,
  tls,
  fetch(req, srv) {
    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    const cpId = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
    counters.upgrades++;
    if (
      srv.upgrade(req, {
        data: { cpId },
        headers: { "Sec-WebSocket-Protocol": "ocpp1.6" },
      })
    )
      return undefined;
    return new Response("upgrade required", { status: 426 });
  },
  websocket: {
    idleTimeout: 0,
    open(ws) {
      const { cpId } = ws.data;
      const old = live.get(cpId);
      if (old) {
        if (values.duplicate === "reject-new") {
          counters.rejectedDuplicate++;
          ws.close(1008, "already exists");
          return;
        }
        old.close(1008, "replaced by new connection");
      }
      const sock: Sock = Object.assign(ws, { cpId });
      live.set(cpId, sock);
      counters.maxLive = Math.max(counters.maxLive, live.size);
      st(cpId).connections++;
    },
    message(ws, raw) {
      const sock = ws as unknown as Sock;
      if (live.get(ws.data.cpId) !== sock) return;
      let frame: unknown;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!Array.isArray(frame)) return;
      if (frame[0] === 3 || frame[0] === 4) {
        const p = pending.get(String(frame[1]));
        if (p) {
          clearTimeout(p.timer);
          pending.delete(String(frame[1]));
          st(p.cpId).answered++;
        }
        return;
      }
      if (frame[0] !== 2) return;
      counters.calls++;
      const [, id, action] = frame as [number, string, string];
      ws.send(JSON.stringify([3, id, conf(action)]));
      if (action === "BootNotification") {
        setTimeout(
          () =>
            csCall(sock, "ChangeConfiguration", {
              key: "HeartbeatInterval",
              value: String(hbInterval),
            }),
          1000,
        );
        setTimeout(
          () =>
            csCall(sock, "TriggerMessage", {
              requestedMessage: "StatusNotification",
            }),
          2000,
        );
      }
    },
    close(ws) {
      if (live.get(ws.data.cpId) === (ws as unknown as Sock))
        live.delete(ws.data.cpId);
    },
  },
});

async function writeStats(): Promise<void> {
  if (!values.stats) return;
  const perCp: Record<string, CpStats> = {};
  for (const [k, v] of stats) perCp[k] = v;
  await Bun.write(
    values.stats,
    JSON.stringify({
      at: new Date().toISOString(),
      live: live.size,
      ...counters,
      perCp,
    }),
  );
}
const statsTimer = setInterval(() => void writeStats(), 5000);

console.log(
  `MOCK_CSMS ${tls ? "wss" : "ws"}://${values.host}:${server.port}/ pid=${process.pid}`,
);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(statsTimer);
  for (const ws of live.values()) ws.close(1012, "service restart");
  await writeStats();
  setTimeout(() => process.exit(0), 300);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
