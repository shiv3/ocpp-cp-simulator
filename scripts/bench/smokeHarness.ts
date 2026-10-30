// Shared harness for the run-level bench tests: a mock CSMS, a slow
// control-plane relay, the real daemon as a subprocess, control-plane
// helpers, and the real `fleet-bench.ts` as a subprocess under a hard
// wall-clock bound.
//
// Used by `fleetBench.smoke.bun.test.ts` (#302), which needs a CSMS that
// answers at once, and by `fleetBench.slowpath.test-bun.ts` (#330, #523),
// which needs a CSMS and a control plane that can be told to be slow. Both
// drive the same processes, so the helpers live here once rather than
// drifting apart in two copies.
import { Server as SocketIoBunEngine } from "@socket.io/bun-engine";
import type { Subprocess } from "bun";
import { join } from "node:path";
import { Server as SocketIoServer } from "socket.io";
import { io, type Socket } from "socket.io-client";

/** Generous on purpose. The assertion is "it terminates at all", not "it is
 *  fast": a tight bound would make this flaky on a loaded CI host and the
 *  flake would be indistinguishable from the hang it exists to catch. A smoke
 *  run takes ~20s; anything past this is a hang. */
export const RUN_BUDGET_MS = 180_000;

const REPO_ROOT = join(import.meta.dir, "..", "..");
const BENCH_SCRIPT = join(import.meta.dir, "fleet-bench.ts");
const DAEMON_SCRIPT = join(REPO_ROOT, "src", "cli", "main.ts");

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
// What it is good for is the two classes the smoke file exists to cover: that
// the run terminates, and that it composes correctly across sweep steps and
// against pre-existing daemon state. Neither needs a strict CSMS. The
// per-action `behaviour` below adds the third (#330): a CSMS that is slow, or
// silent, on one action, which is what the teardown guards only engage on.
// ---------------------------------------------------------------------------

export interface MockCsms {
  readonly wsUrl: string;
  /** StartTransaction minus StopTransaction, counted on receipt whatever id
   *  the stop carries. A run must leave this at zero: the CSMS is a
   *  third-party system whose state the benchmark cannot enumerate, so the
   *  only way to leave it as found is to close what was opened, before the
   *  charge point that could close it is deleted. */
  openTransactions(): number;
  /** Transaction ids this CSMS assigned and has not seen a StopTransaction
   *  *carrying that id* for. Stricter than {@link openTransactions}: a stop
   *  sent with the placeholder id (0) before the conf assigned the real one
   *  decrements the count but closes nothing here — which is what a real CSMS
   *  sees too. Ids are assigned on receipt of the StartTransaction, not when
   *  its (possibly delayed) conf is sent: that is when a CSMS opens the
   *  session. */
  openTransactionIds(): number[];
  /** The `transactionId` of every StopTransaction that matched no open id. */
  unmatchedStops(): unknown[];
  /** CALLs of `action` received so far (answered or not). */
  calls(action: string): number;
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

/** How the mock answers one action. Absent means "at once". */
export interface ActionBehaviour {
  /** Wait this long before sending the conf. The CALL is still counted (and a
   *  StartTransaction still assigned its id) on receipt. */
  readonly delayMs?: number;
  /** Answer the first `stallAfter` calls of this action, then never answer
   *  another while keeping the socket open. `0` stalls every call. */
  readonly stallAfter?: number;
}

/** A CALL the mock received, as reported to {@link MockCsmsOptions.onCall}
 *  and {@link MockCsmsOptions.onReply}. */
export interface MockCall {
  readonly cpId: string;
  readonly action: string;
  /** 1-based count of this action across every charge point. */
  readonly nth: number;
  /** The CALL's payload, as received. */
  readonly payload: Readonly<Record<string, unknown>> | undefined;
}

export interface MockCsmsOptions {
  /** Close each charge point's socket exactly once, right after answering its
   *  first Heartbeat, so the reconnect → BootNotification → `Accepted` path
   *  runs under a live benchmark. */
  readonly dropOnFirstHeartbeat?: boolean;
  /** Per-action delay and stall, keyed by OCPP action name. */
  readonly behaviour?: Readonly<Record<string, ActionBehaviour>>;
  /** Called on receipt of every CALL, before any delay. */
  readonly onCall?: (call: MockCall) => void;
  /** Called right after a conf is sent (never for a stalled call). */
  readonly onReply?: (call: MockCall) => void;
}

/** Per-socket bookkeeping, so a Heartbeat can be attributed to the connection
 *  it arrived on rather than to the charge point in aggregate. */
interface CsmsSocketData {
  readonly cpId: string;
  /** 1-based: the first connection is 1, the one after a reconnect is 2. */
  readonly connection: number;
}

export function startMockCsms(options: MockCsmsOptions = {}): MockCsms {
  let blackHoled = false;
  let transactionId = 1;
  let open = 0;
  const openIds = new Set<number>();
  const unmatched: unknown[] = [];
  const callCounts = new Map<string, number>();
  const seenIdTags = new Set<string>();
  /** cpId -> how many sockets it has opened. */
  const connectionCounts = new Map<string, number>();
  /** cpId -> heartbeats per connection, indexed by `connection - 1`. */
  const heartbeats = new Map<string, number[]>();
  /** cpIds already dropped once, so the drop happens exactly once each. */
  const alreadyDropped = new Set<string>();
  /** Delayed replies not yet sent, so `stop()` can cancel them. */
  const pendingReplies = new Set<ReturnType<typeof setTimeout>>();
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
        const { cpId, connection } = ws.data;
        const nth = (callCounts.get(action) ?? 0) + 1;
        callCounts.set(action, nth);
        const call: MockCall = { cpId, action, nth, payload };
        options.onCall?.(call);
        const idTag = payload?.idTag;
        if (typeof idTag === "string") seenIdTags.add(idTag);
        if (action === "StartTransaction") open++;
        if (action === "StopTransaction") {
          open--;
          const stopped = payload?.transactionId;
          if (typeof stopped === "number" && openIds.has(stopped)) {
            openIds.delete(stopped);
          } else {
            unmatched.push(stopped);
          }
        }
        if (action === "Heartbeat") {
          const perConnection = heartbeats.get(cpId) ?? [];
          perConnection[connection - 1] =
            (perConnection[connection - 1] ?? 0) + 1;
          heartbeats.set(cpId, perConnection);
        }
        // Built on receipt, so a StartTransaction's id is allocated when the
        // CSMS would open the session, however long its conf is held back.
        const conf = confFor(action);
        const behaviour = options.behaviour?.[action];
        if (behaviour?.stallAfter !== undefined && nth > behaviour.stallAfter) {
          return;
        }
        const reply = (): void => {
          // The socket may have closed while the reply was held back — the
          // charge point deleted under a slow conf is a case these tests
          // create on purpose — and a send on a closed socket is a no-op.
          ws.send(JSON.stringify([3, messageId, conf]));
          options.onReply?.(call);
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
        };
        const delayMs = behaviour?.delayMs ?? 0;
        if (delayMs <= 0) {
          reply();
          return;
        }
        const timer = setTimeout(() => {
          pendingReplies.delete(timer);
          reply();
        }, delayMs);
        pendingReplies.add(timer);
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
      case "StartTransaction": {
        const id = transactionId++;
        openIds.add(id);
        return { transactionId: id, idTagInfo: { status: "Accepted" } };
      }
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
    openTransactionIds: () => [...openIds],
    unmatchedStops: () => [...unmatched],
    calls: (action) => callCounts.get(action) ?? 0,
    idTags: () => [...seenIdTags],
    blackHole: () => {
      blackHoled = true;
    },
    connections: (cpId) => connectionCounts.get(cpId) ?? 0,
    heartbeatsOnConnection: (cpId, n) => heartbeats.get(cpId)?.[n - 1] ?? 0,
    chargePointIds: () => [...connectionCounts.keys()],
    stop: () => {
      for (const timer of pendingReplies) clearTimeout(timer);
      pendingReplies.clear();
      server.stop(true);
    },
  };
}

// ---------------------------------------------------------------------------
// The real daemon, as a subprocess.
// ---------------------------------------------------------------------------

export interface Daemon {
  readonly url: string;
  stop(): void;
}

export async function startDaemon(): Promise<Daemon> {
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
    { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT },
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
// A slow control plane: a socket.io relay in front of the real daemon.
//
// The mock CSMS can slow the CSMS-side stages of a cycle, never a
// control-plane RPC: the daemon acks `start_transaction` before Authorize is
// answered and `stop_transaction` once the frame is queued, and its
// `cp.create_many` handler does not wait for a charge point to connect. This
// relay is the other half (#330, #523). The bench is pointed at it with
// `--daemon-url`; it accepts the bench's sockets, opens one socket to the
// daemon per bench socket — with the same handshake `auth`, so the daemon's
// own check decides — and re-emits every event both ways, acks included.
// Anything that is not socket.io (`/v1/healthz`, `/metrics`) is proxied over
// HTTP unchanged. A daemon socket that closes closes the bench's transport,
// which the bench reconnects after; its unanswered RPCs get a synthetic
// `relay_upstream_closed` ack. Nothing else about a real outage is modelled.
//
// It delays the **request**, not the answer: a held RPC reaches the daemon
// late, which is what a slow handler looks like from the bench — the work
// happens after the client may have given up. Holding the answer instead
// would let the daemon act at once, and nothing the bench does afterwards
// could then race it.
// ---------------------------------------------------------------------------

/** One `rpc` event the relay received from the bench. */
export interface RelayedRpc {
  readonly method: string;
  /** The target charge point: the envelope's `cpId`, or `params.cpId` for a
   *  daemon-level method such as `cp.delete`. */
  readonly cpId: string | undefined;
  /** 1-based count of this method across every bench socket. */
  readonly nth: number;
  readonly receivedAtMs: number;
  /** When it was emitted to the daemon; `null` while held. */
  forwardedAtMs: number | null;
  /** When the daemon's ack came back; `null` until then. */
  answeredAtMs: number | null;
  /** The daemon's ack, as received. */
  ack: { ok: boolean; error?: { code: string } } | null;
}

export interface SlowControlPlaneOptions {
  readonly daemonUrl: string;
  /** How long to hold this RPC before forwarding it to the daemon: a number
   *  of milliseconds (`0`, or absent, forwards at once), or a promise the
   *  request is held until — so a case can release it on an event rather
   *  than race a timer against another process. */
  readonly holdRequestMs?: (call: RelayedRpc) => number | Promise<unknown>;
  /** Called on receipt of every RPC, before any hold. */
  readonly onRpc?: (call: RelayedRpc) => void;
  /** Called once the daemon's ack for an RPC is in (or the relay's synthetic
   *  one, if the daemon's socket closed first). */
  readonly onAnswer?: (call: RelayedRpc) => void;
}

/** The ack the relay gives an RPC whose daemon socket closed before the
 *  daemon answered it: socket.io-client never calls an ack on a disconnected
 *  socket, so without it `drained()` would wait forever. */
export const RELAY_UPSTREAM_CLOSED = "relay_upstream_closed";

export interface SlowControlPlane {
  /** What to pass the bench as `--daemon-url`. */
  readonly url: string;
  /** Every RPC received so far, in arrival order. */
  rpcs(): readonly RelayedRpc[];
  /** Resolves once every RPC received so far has been forwarded and answered
   *  by the daemon — including those whose bench socket is gone — or settled
   *  with {@link RELAY_UPSTREAM_CLOSED} because the daemon's socket closed. A test must
   *  await this before reading the daemon's state, or a request the relay
   *  still holds lands after the assertion. */
  drained(): Promise<void>;
  stop(): void;
}

export interface SocketIoEndpoint {
  readonly io: SocketIoServer;
  readonly port: number;
  stop(): void;
}

/** A socket.io server on an ephemeral port, at the `/socket.io/` path the
 *  daemon uses. Any other request goes to `fallback`, or is answered 404. */
export function serveSocketIo(
  fallback?: (req: Request) => Response | Promise<Response>,
): SocketIoEndpoint {
  const io = new SocketIoServer({ serveClient: false });
  const engine = new SocketIoBunEngine({ path: "/socket.io/" });
  io.bind(engine);
  const handler = engine.handler();
  const server = Bun.serve({
    port: 0,
    idleTimeout: handler.idleTimeout,
    websocket: handler.websocket,
    fetch(req, srv) {
      if (!fallback || new URL(req.url).pathname.startsWith("/socket.io/")) {
        return engine.handleRequest(req, srv as never);
      }
      return fallback(req);
    },
  });
  return {
    io,
    port: server.port!,
    stop: () => {
      void io.close();
      server.stop(true);
    },
  };
}

export function startSlowControlPlane(
  options: SlowControlPlaneOptions,
): SlowControlPlane {
  const daemonUrl = options.daemonUrl.replace(/\/$/, "");
  const endpoint = serveSocketIo((req) => {
    const url = new URL(req.url);
    return fetch(`${daemonUrl}${url.pathname}${url.search}`, {
      method: req.method,
      headers: req.headers,
      body:
        req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    });
  });
  const relay = endpoint.io;
  const log: RelayedRpc[] = [];
  const counts = new Map<string, number>();
  const holds = new Set<ReturnType<typeof setTimeout>>();
  const upstreams = new Set<Socket>();
  let pending = 0;
  let waiters: Array<() => void> = [];
  const settleOne = (): void => {
    pending--;
    if (pending === 0) {
      const ready = waiters;
      waiters = [];
      for (const resolve of ready) resolve();
    }
  };

  // The daemon's socket is opened during the handshake, so a refusal there —
  // bad credentials, a daemon that is down — refuses the bench's socket too.
  relay.use((socket, next) => {
    const upstream = io(daemonUrl, {
      path: "/socket.io/",
      auth: socket.handshake.auth,
      reconnection: false,
    });
    upstream.once("connect", () => {
      socket.data.upstream = upstream;
      upstreams.add(upstream);
      next();
    });
    upstream.once("connect_error", (err: Error) => {
      upstream.disconnect();
      next(err);
    });
  });

  relay.on("connection", (socket) => {
    const upstream = socket.data.upstream as Socket;
    /** Settles each RPC of this socket not yet answered, held ones included. */
    const unsettled = new Set<(answer: RelayedRpc["ack"]) => void>();
    let downstreamGone = false;
    const closeUpstreamIfIdle = (): void => {
      if (downstreamGone && unsettled.size === 0) {
        upstreams.delete(upstream);
        upstream.disconnect();
      }
    };
    upstream.onAny((event: string, ...args: unknown[]) => {
      socket.emit(event, ...args);
    });
    upstream.on("disconnect", () => {
      for (const settle of [...unsettled]) {
        settle({ ok: false, error: { code: RELAY_UPSTREAM_CLOSED } });
      }
      // A transport close, not `socket.disconnect(true)`: a server-initiated
      // disconnect is one socket.io-client never reconnects after, while the
      // bench's pool reconnects after a dropped transport — which is what a
      // daemon going away looks like. The relay's next handshake then opens a
      // fresh daemon socket, or refuses the bench if the daemon is gone.
      socket.conn.close();
    });
    socket.on("disconnect", () => {
      // The daemon keeps running whatever the bench gave up on, so a held
      // request is still delivered after its bench socket has closed — that
      // late delivery is the case under test.
      downstreamGone = true;
      closeUpstreamIfIdle();
    });
    socket.onAny((event: string, ...args: unknown[]) => {
      const last = args[args.length - 1];
      const ack = typeof last === "function" ? last : null;
      const payload = ack ? args.slice(0, -1) : args;
      if (event !== "rpc") {
        if (ack) upstream.emit(event, ...payload, ack);
        else upstream.emit(event, ...payload);
        return;
      }
      const request = (payload[0] ?? {}) as {
        method?: unknown;
        cpId?: unknown;
        params?: { cpId?: unknown };
      };
      const method = String(request.method);
      const nth = (counts.get(method) ?? 0) + 1;
      counts.set(method, nth);
      const target = request.cpId ?? request.params?.cpId;
      const call: RelayedRpc = {
        method,
        cpId: typeof target === "string" ? target : undefined,
        nth,
        receivedAtMs: Date.now(),
        forwardedAtMs: null,
        answeredAtMs: null,
        ack: null,
      };
      log.push(call);
      pending++;
      const settle = (answer: RelayedRpc["ack"]): void => {
        if (!unsettled.delete(settle)) return;
        call.answeredAtMs = Date.now();
        call.ack = answer;
        // A send on a closed socket is a no-op, and the bench drops an ack
        // for a call it already timed out.
        ack?.(answer);
        options.onAnswer?.(call);
        settleOne();
        closeUpstreamIfIdle();
      };
      unsettled.add(settle);
      options.onRpc?.(call);
      const forward = (): void => {
        // Settled already when the daemon's socket closed during the hold.
        if (!unsettled.has(settle)) return;
        call.forwardedAtMs = Date.now();
        upstream.emit("rpc", ...payload, settle);
      };
      const hold = options.holdRequestMs?.(call) ?? 0;
      if (typeof hold !== "number") {
        void hold.then(forward, forward);
        return;
      }
      if (hold <= 0) {
        forward();
        return;
      }
      const timer = setTimeout(() => {
        holds.delete(timer);
        forward();
      }, hold);
      holds.add(timer);
    });
  });

  return {
    url: `http://127.0.0.1:${endpoint.port}`,
    rpcs: () => [...log],
    drained: () =>
      pending === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push(resolve)),
    stop: () => {
      for (const timer of holds) clearTimeout(timer);
      holds.clear();
      // Disconnecting settles every RPC still held or unanswered, through
      // each daemon socket's `disconnect` handler.
      for (const upstream of upstreams) upstream.disconnect();
      upstreams.clear();
      endpoint.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// Control-plane helpers, for arranging and inspecting daemon state.
// ---------------------------------------------------------------------------

export async function withControlPlane<T>(
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

/** The daemon's charge point ids, through an open control-plane `rpc`. */
export async function cpIdsVia(
  rpc: (method: string, params: unknown) => Promise<unknown>,
): Promise<string[]> {
  const result = (await rpc("cp.list", {})) as
    { cps?: { cpId: string }[] } | { cpId: string }[];
  const cps = Array.isArray(result) ? result : (result.cps ?? []);
  return cps.map((c) => c.cpId);
}

export async function listCpIds(daemonUrl: string): Promise<string[]> {
  return withControlPlane(daemonUrl, cpIdsVia);
}

// ---------------------------------------------------------------------------
// The real benchmark, as a subprocess.
// ---------------------------------------------------------------------------

export interface RunOutcome {
  readonly exitCode: number | null;
  readonly elapsedMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface RunningBench {
  /** The subprocess, so a test can signal it mid-run. */
  readonly proc: Subprocess<"ignore", "pipe", "pipe">;
  /** Settles once the process has exited and both pipes are drained. */
  readonly done: Promise<RunOutcome>;
}

/** Start the real script as a subprocess, under a hard wall-clock bound.
 *  `env` is added to this process's environment — the only channel into the
 *  subprocess for the test-only `FLEET_BENCH_TEST_*` timings. */
export function startBench(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): RunningBench {
  const startedAt = Date.now();
  const proc = Bun.spawn(["bun", BENCH_SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
  });
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, RUN_BUDGET_MS);
  const done = (async (): Promise<RunOutcome> => {
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
  })();
  return { proc, done };
}

/** Run the real script to completion, under a hard wall-clock bound. */
export function runBench(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<RunOutcome> {
  return startBench(args, env).done;
}
