// Golden wire test (docs/concepts/charger-engine.md, Stage A): an in-process
// fake CSMS that records every OCPP-J frame in arrival order and answers the
// charge point's calls from a small, deterministic script. Runs under `bun
// test` only (Bun.serve).
import type { ServerWebSocket } from "bun";
import { tcpPort } from "../bunServe";
import { drainMicrotasks } from "../../cp/shared/clock";
import {
  installMemoryTransport,
  type MemoryServerSocket,
} from "./memoryTransport";

type MemorySocketLike = MemoryServerSocket;
let memoryCount = 0;

export type WireVersion = "1.6" | "2.0.1" | "2.1";

/** One recorded frame, in the order the fake CSMS saw or sent it. */
export interface WireFrame {
  /** `CP>` arrived from the charge point; `CSMS>` was sent by the fake CSMS. */
  readonly dir: "CP>" | "CSMS>";
  /** `raw` is a frame that is not a valid OCPP-J message (not JSON, not an
   *  array, or an unknown message type); `payload` is the received text. */
  readonly kind: "call" | "result" | "error" | "raw";
  readonly id: string;
  readonly action?: string;
  readonly payload: unknown;
}

export type CsmsReply =
  | { readonly result: unknown }
  | { readonly error: { code: string; description: string } }
  | "silent";

/** What the script knows when it answers one call. */
export interface CsmsCallContext {
  readonly csms: FakeCsms;
  /** Counts calls of this action so far, this one included. */
  readonly nth: number;
}

export type CsmsResponder = (
  payload: Record<string, unknown>,
  ctx: CsmsCallContext,
) => CsmsReply | unknown;

export interface FakeCsmsOptions {
  readonly version: WireVersion;
  /** Overrides, by action, of the built-in script. */
  readonly responders?: Readonly<Record<string, CsmsResponder>>;
  /** Fixed clock string used in every `currentTime` the script answers. */
  readonly currentTime?: string;
  /**
   * Talk to the station over an in-memory socket instead of a real one: no
   * listening port, no real I/O. For virtual-time runs.
   */
  readonly memory?: boolean;
}

const FIXED_TIME = "2030-01-01T00:00:00.000Z";

interface Waiter {
  readonly pred: (frame: WireFrame) => boolean;
  readonly resolve: (frame: WireFrame) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function isReply(value: unknown): value is CsmsReply {
  if (value === "silent") return true;
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] === "result" || keys[0] === "error");
}

/** Deterministic id for the next CSMS-initiated CALL: `csms-1`, `csms-2`, ... */
export class FakeCsms {
  readonly frames: WireFrame[] = [];
  private readonly token = crypto.randomUUID();
  /** The path of every WebSocket upgrade request (not part of the transcript). */
  readonly requestPaths: string[] = [];
  readonly url: string;
  private readonly server: ReturnType<typeof Bun.serve> | null;
  private socket: ServerWebSocket<unknown> | MemorySocketLike | null = null;
  private uninstallMemory: (() => void) | null = null;
  /** True when the station is wired through the in-memory transport. */
  readonly memory: boolean;
  private readonly waiters = new Set<Waiter>();
  private readonly connectionWaiters = new Set<() => void>();
  private readonly callCounts = new Map<string, number>();
  private readonly pending = new Map<string, (frame: WireFrame) => void>();
  private nextCallId = 0;
  private transactionCounter = 0;
  private lastFrameAt = Date.now();
  private opens = 0;
  private closes = 0;
  readonly responders: Record<string, CsmsResponder>;
  readonly version: WireVersion;
  private readonly currentTime: string;

  constructor(options: FakeCsmsOptions) {
    this.version = options.version;
    this.currentTime = options.currentTime ?? FIXED_TIME;
    this.responders = { ...(options.responders ?? {}) };
    const protocol =
      this.version === "1.6"
        ? "ocpp1.6"
        : this.version === "2.1"
          ? "ocpp2.1"
          : "ocpp2.0.1";
    this.memory = options.memory === true;
    if (this.memory) {
      this.server = null;
      this.url = `ws://memory-csms-${++memoryCount}.invalid/`;
      this.uninstallMemory = installMemoryTransport(this);
      return;
    }
    this.server = Bun.serve({
      port: 0,
      fetch: (req, srv) => {
        // A station left over from an earlier case can still be retrying a
        // port that this server was given later; only this server's own token
        // is let in, so no case can see another case's frames.
        const path = new URL(req.url).pathname;
        if (!path.startsWith(`/${this.token}/`)) {
          return new Response("not this server's station", { status: 404 });
        }
        this.requestPaths.push(path.slice(this.token.length + 1));
        const upgraded = srv.upgrade(req, {
          data: undefined,
          headers: { "Sec-WebSocket-Protocol": protocol },
        });
        if (upgraded) return undefined;
        return new Response("expected websocket upgrade", { status: 426 });
      },
      websocket: {
        open: (ws) => {
          this.socket = ws;
          this.opens++;
          for (const wake of [...this.connectionWaiters]) wake();
        },
        message: (_ws, message) => {
          this.onMessage(
            typeof message === "string" ? message : message.toString(),
          );
        },
        close: () => {
          this.closes++;
          this.socket = null;
        },
      },
    });
    this.url = `ws://127.0.0.1:${tcpPort(this.server)}/${this.token}/`;
  }

  /** In-memory transport: the station's socket opened. */
  attachMemoryClient(socket: MemoryServerSocket): void {
    this.socket = socket;
    this.opens++;
    for (const wake of [...this.connectionWaiters]) wake();
  }

  /** In-memory transport: a frame arrived from the station. */
  receiveFromClient(raw: string): void {
    this.onMessage(raw);
  }

  /** In-memory transport: the connection ended. Counts once per connection. */
  memoryClientClosed(): void {
    if (!this.socket) return;
    this.closes++;
    this.socket = null;
  }

  get openCount(): number {
    return this.opens;
  }

  get closeCount(): number {
    return this.closes;
  }

  get connected(): boolean {
    return this.socket !== null;
  }

  private record(frame: WireFrame): void {
    this.frames.push(frame);
    this.lastFrameAt = Date.now();
    for (const waiter of [...this.waiters]) {
      if (waiter.pred(frame)) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(frame);
      }
    }
  }

  private onMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.record({ dir: "CP>", kind: "raw", id: "", payload: raw });
      return;
    }
    if (
      !Array.isArray(parsed) ||
      ![2, 3, 4].includes(parsed[0] as number) ||
      typeof parsed[1] !== "string"
    ) {
      this.record({ dir: "CP>", kind: "raw", id: "", payload: raw });
      return;
    }
    const [type, id] = parsed as [number, string];
    if (type === 2) {
      const action = parsed[2] as string;
      const payload = parsed[3] as unknown;
      this.record({ dir: "CP>", kind: "call", id, action, payload });
      this.answer(id, action, (payload ?? {}) as Record<string, unknown>);
    } else if (type === 3) {
      const frame: WireFrame = {
        dir: "CP>",
        kind: "result",
        id,
        payload: parsed[2],
      };
      this.record(frame);
      this.pending.get(id)?.(frame);
      this.pending.delete(id);
    } else if (type === 4) {
      const frame: WireFrame = {
        dir: "CP>",
        kind: "error",
        id,
        payload: {
          code: parsed[2],
          description: parsed[3],
          details: parsed[4],
        },
      };
      this.record(frame);
      this.pending.get(id)?.(frame);
      this.pending.delete(id);
    }
  }

  private answer(
    id: string,
    action: string,
    payload: Record<string, unknown>,
  ): void {
    const nth = (this.callCounts.get(action) ?? 0) + 1;
    this.callCounts.set(action, nth);
    const responder = this.responders[action] ?? this.defaultResponder(action);
    const out = responder(payload, { csms: this, nth });
    const reply: CsmsReply = isReply(out) ? out : { result: out ?? {} };
    if (reply === "silent") return;
    if ("error" in reply) {
      this.sendRaw(
        {
          dir: "CSMS>",
          kind: "error",
          id,
          payload: reply.error,
        },
        [4, id, reply.error.code, reply.error.description, {}],
      );
      return;
    }
    this.sendRaw({ dir: "CSMS>", kind: "result", id, payload: reply.result }, [
      3,
      id,
      reply.result,
    ]);
  }

  private sendRaw(frame: WireFrame, wire: unknown[]): void {
    this.record(frame);
    this.socket?.send(JSON.stringify(wire));
  }

  private defaultResponder(action: string): CsmsResponder {
    const accepted = { status: "Accepted" };
    if (this.version === "1.6") {
      switch (action) {
        case "BootNotification":
          return () => ({
            status: "Accepted",
            currentTime: this.currentTime,
            interval: 3600,
          });
        case "Heartbeat":
          return () => ({ currentTime: this.currentTime });
        case "Authorize":
          return (p) => ({ idTagInfo: idTagInfo16(String(p.idTag)) });
        case "StartTransaction":
          return (p) => ({
            transactionId: ++this.transactionCounter,
            idTagInfo: idTagInfo16(String(p.idTag)),
          });
        case "StopTransaction":
          return (p) =>
            p.idTag === undefined
              ? {}
              : { idTagInfo: idTagInfo16(String(p.idTag)) };
        case "DataTransfer":
          return () => accepted;
        default:
          return () => ({});
      }
    }
    switch (action) {
      case "BootNotification":
        return () => ({
          status: "Accepted",
          currentTime: this.currentTime,
          interval: 3600,
        });
      case "Heartbeat":
        return () => ({ currentTime: this.currentTime });
      case "Authorize":
        return (p) => ({ idTokenInfo: idTokenInfo201(p) });
      case "TransactionEvent":
        return (p) =>
          p.idToken === undefined ? {} : { idTokenInfo: idTokenInfo201(p) };
      case "DataTransfer":
        return () => accepted;
      case "SignCertificate":
      case "Get15118EVCertificate":
        return () => ({ status: "Rejected" });
      default:
        return () => ({});
    }
  }

  /** Resolves once the charge point has opened a connection (or at once). */
  waitForConnection(timeoutMs = 10_000): Promise<void> {
    if (this.socket) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connectionWaiters.delete(wake);
        reject(new Error("fake CSMS: timed out waiting for a connection"));
      }, timeoutMs);
      const wake = () => {
        clearTimeout(timer);
        this.connectionWaiters.delete(wake);
        resolve();
      };
      this.connectionWaiters.add(wake);
    });
  }

  /** The first frame recorded at or after index `from` that matches. */
  waitForFrame(
    pred: (frame: WireFrame) => boolean,
    options: { from?: number; timeoutMs?: number } = {},
  ): Promise<WireFrame> {
    const from = options.from ?? 0;
    for (let i = from; i < this.frames.length; i++) {
      if (pred(this.frames[i])) return Promise.resolve(this.frames[i]);
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        pred,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(
            new Error(
              `fake CSMS: timed out waiting for a frame (have ${this.frames
                .map((f) => `${f.dir}${f.action ?? f.kind}`)
                .join(", ")})`,
            ),
          );
        }, options.timeoutMs ?? 15_000),
      };
      this.waiters.add(waiter);
    });
  }

  /** The `nth` (1-based) CALL from the charge point with this action. */
  waitForCall(
    action: string,
    options: { nth?: number; timeoutMs?: number } = {},
  ): Promise<WireFrame> {
    const nth = options.nth ?? 1;
    let seen = 0;
    return this.waitForFrame(
      (f) => {
        if (f.dir === "CP>" && f.kind === "call" && f.action === action) {
          seen++;
          return seen === nth;
        }
        return false;
      },
      { timeoutMs: options.timeoutMs },
    );
  }

  /** Number of frames recorded so far; use as the `from` of a later wait. */
  mark(): number {
    return this.frames.length;
  }

  /**
   * Resolves when no frame moved for `quietMs`. This is how a driver waits for
   * a cascade of follow-up traffic to end before the next step; it never
   * decides the order of frames, only when the next step starts.
   */
  async settle(quietMs = 250, maxMs = 20_000): Promise<void> {
    if (this.memory) return this.settleMemory();
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (Date.now() - this.lastFrameAt >= quietMs) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("fake CSMS: traffic never settled");
  }

  /**
   * In-memory transport: wait until a few turns of the event loop moved no
   * frame. Takes no real time; the turns are the only waiting.
   */
  private async settleMemory(): Promise<void> {
    let quiet = 0;
    let seen = this.frames.length;
    for (let turns = 0; quiet < 3; turns++) {
      if (turns > 100_000) throw new Error("fake CSMS: traffic never settled");
      await drainMicrotasks();
      if (this.frames.length === seen) quiet++;
      else {
        quiet = 0;
        seen = this.frames.length;
      }
    }
  }

  /**
   * Send a CSMS-initiated CALL and wait for the charge point's answer. The
   * message id is deterministic (`csms-N`).
   */
  call(
    action: string,
    payload: unknown,
    timeoutMs = 10_000,
  ): Promise<WireFrame> {
    const id = `csms-${++this.nextCallId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`fake CSMS: no answer to ${action}`));
      }, timeoutMs);
      this.pending.set(id, (frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
      this.record({ dir: "CSMS>", kind: "call", id, action, payload });
      this.socket?.send(JSON.stringify([2, id, action, payload]));
    });
  }

  /** Send a CSMS CALL without waiting for the answer. */
  callNoWait(action: string, payload: unknown): string {
    const id = `csms-${++this.nextCallId}`;
    this.record({ dir: "CSMS>", kind: "call", id, action, payload });
    this.socket?.send(JSON.stringify([2, id, action, payload]));
    return id;
  }

  /** Close the current connection from the CSMS side. */
  dropConnection(code = 1006): void {
    this.socket?.close(code);
  }

  async stop(): Promise<void> {
    for (const waiter of [...this.waiters]) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("fake CSMS stopped"));
    }
    this.waiters.clear();
    this.uninstallMemory?.();
    this.uninstallMemory = null;
    if (!this.server) return;
    await Promise.race([
      this.server.stop(true),
      new Promise<void>((resolve) => setTimeout(resolve, 50)),
    ]);
  }
}

/** idTags starting with `INV`, `EXP`, `BLK` get that outcome; others Accepted. */
function idTagInfo16(idTag: string): Record<string, unknown> {
  if (idTag.startsWith("CERT023-INV")) return { status: "Invalid" };
  if (idTag.startsWith("CERT023-EXP")) {
    return { status: "Expired", expiryDate: "2020-01-01T00:00:00.000Z" };
  }
  if (idTag.startsWith("CERT023-BLK")) return { status: "Blocked" };
  return { status: "Accepted" };
}

function idTokenInfo201(p: Record<string, unknown>): Record<string, unknown> {
  const token = (p.idToken as { idToken?: string } | undefined)?.idToken ?? "";
  if (token.startsWith("INVALID")) return { status: "Invalid" };
  return { status: "Accepted" };
}
