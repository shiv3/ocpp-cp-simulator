// src/cli/exportK6/runtime/ocppClient.ts
// The k6-side OCPP charge point: WebSocket transport, serial outgoing-call
// queue (OCPP §4.1.1: one in-flight CALL), auto-responder wiring, heartbeat
// scheduler, and the ScenarioHost implementation the interpreter drives.
import { WebSocket } from "k6/experimental/websockets";
import {
  clearInterval,
  clearTimeout,
  setInterval,
  setTimeout,
} from "k6/timers";
import {
  createMessageIdGenerator,
  decodeFrame,
  encodeCall,
  encodeCallResult,
} from "./frames";
import {
  createResponderState,
  respondToCall16,
  type ResponderState,
} from "./autoResponder";
import type { ScenarioHost } from "./interpreter";
import type { CpIdentity, TranscriptEntry, Wire, WireCall } from "./types";
import {
  ocppBootTime,
  ocppCallDuration,
  ocppCalls,
  ocppErrors,
} from "./metrics";

interface PendingCall {
  action: string;
  messageId: string;
  sentAtMs: number;
  entry: TranscriptEntry;
  resolve: (payload: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timeoutId: number;
}

interface QueuedCall {
  call: WireCall;
  resolve: (payload: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

interface CallWaiter {
  actions: readonly string[];
  resolve: (evt: { action: string; payload: Record<string, unknown> }) => void;
  reject: (err: Error) => void;
  timeoutId: number | null;
}

interface StatusWaiter {
  target: string;
  resolve: () => void;
  reject: (err: Error) => void;
  timeoutId: number | null;
}

export interface OcppChargePointOptions {
  url: string;
  identity: CpIdentity;
  wire: Wire;
  connectorId: number;
  callTimeoutMs?: number;
}

export class OcppChargePoint implements ScenarioHost {
  readonly connectorId: number;
  readonly wire: Wire;
  private readonly opts: OcppChargePointOptions;
  private readonly nextMessageId: () => string;
  private ws: WebSocket | null = null;
  private pending: PendingCall | null = null;
  private queue: QueuedCall[] = [];
  private callWaiters: CallWaiter[] = [];
  private statusWaiters: StatusWaiter[] = [];
  private readonly entries: TranscriptEntry[] = [];
  private readonly responder: ResponderState = createResponderState();
  private localStatus = "Available";
  private heartbeatId: number | null = null;
  private closed = false;
  private readonly startMs = Date.now();

  constructor(opts: OcppChargePointOptions) {
    this.opts = opts;
    this.wire = opts.wire;
    this.connectorId = opts.connectorId;
    this.nextMessageId = createMessageIdGenerator(opts.identity.cpId);
  }

  connect(): Promise<void> {
    const { url, identity } = this.opts;
    const wsUrl = `${url.replace(/\/+$/, "")}/${encodeURIComponent(identity.cpId)}`;
    const headers: Record<string, string> = {
      "Sec-WebSocket-Protocol": this.wire.subprotocol,
    };
    if (identity.basicPassword !== undefined) {
      // btoa is not available in k6's runtime; polyfill-free base64 via
      // Uint8Array is overkill for ASCII credentials — encodeCredentials
      // below handles it.
      headers.Authorization = `Basic ${encodeCredentials(identity.cpId, identity.basicPassword)}`;
    }
    this.ws = new WebSocket(wsUrl, this.wire.subprotocol, { headers });
    const ws = this.ws;
    return new Promise<void>((resolve, reject) => {
      const bootStarted = Date.now();
      ws.addEventListener("error", (e) => {
        this.failAll(
          new Error(`websocket error: ${String(e.error ?? "unknown")}`),
        );
        reject(new Error(`websocket error for ${identity.cpId}`));
      });
      ws.addEventListener("close", () => {
        this.failAll(new Error("websocket closed"));
      });
      ws.addEventListener("message", (e) => {
        if (typeof e.data === "string") this.onFrame(e.data);
      });
      ws.addEventListener("open", () => {
        this.call(this.wire.bootNotification(identity.cpId))
          .then((conf) => {
            ocppBootTime.add(Date.now() - bootStarted);
            if (conf.status !== "Accepted") {
              reject(new Error(`BootNotification ${String(conf.status)}`));
              return;
            }
            const intervalSec =
              typeof conf.interval === "number" && conf.interval > 0
                ? conf.interval
                : 300;
            this.heartbeatId = setInterval(() => {
              void this.call(this.wire.heartbeat()).catch(() => {
                // Heartbeat failures surface via ocpp_errors; keep the VU alive.
              });
            }, intervalSec * 1000);
            resolve();
          })
          .catch(reject);
      });
    });
  }

  call(c: WireCall): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error("connection closed"));
        return;
      }
      this.queue.push({ call: c, resolve, reject });
      this.flush();
    });
  }

  private flush(): void {
    if (
      this.closed ||
      this.pending !== null ||
      this.queue.length === 0 ||
      this.ws === null
    ) {
      return;
    }
    const { call, resolve, reject } = this.queue.shift() as QueuedCall;
    const messageId = this.nextMessageId();
    const entry: TranscriptEntry = {
      direction: "sent",
      action: call.action,
      payload: call.payload,
      timeMs: Date.now() - this.startMs,
    };
    this.entries.push(entry);
    ocppCalls.add(1, { action: call.action });
    const timeoutMs = this.opts.callTimeoutMs ?? 30_000;
    const timeoutId = setTimeout(() => {
      if (this.pending?.timeoutId === timeoutId) {
        const p = this.pending;
        this.pending = null;
        p.entry.errorCode = "Timeout";
        ocppErrors.add(1, { action: p.action, kind: "timeout" });
        p.reject(new Error(`${p.action} timed out after ${timeoutMs}ms`));
        this.flush();
      }
    }, timeoutMs);
    this.pending = {
      action: call.action,
      messageId,
      sentAtMs: Date.now(),
      entry,
      resolve,
      reject,
      timeoutId,
    };
    try {
      this.ws.send(encodeCall(messageId, call.action, call.payload));
    } catch (err) {
      clearTimeout(timeoutId);
      this.pending = null;
      ocppErrors.add(1, { action: call.action, kind: "send_failed" });
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
  }

  private onFrame(raw: string): void {
    const frame = decodeFrame(raw);
    if (frame === null) return;
    if (frame.kind === "result" || frame.kind === "error") {
      const p = this.pending;
      if (p === null || p.messageId !== frame.messageId) {
        ocppErrors.add(1, { action: "unknown", kind: "stale_response" });
        return;
      }
      this.pending = null;
      clearTimeout(p.timeoutId);
      if (frame.kind === "result") {
        p.entry.response = frame.payload;
        ocppCallDuration.add(Date.now() - p.sentAtMs, { action: p.action });
        p.resolve(frame.payload);
      } else {
        p.entry.errorCode = frame.errorCode;
        ocppErrors.add(1, { action: p.action, kind: "callerror" });
        p.reject(
          new Error(
            `${p.action} CALLERROR ${frame.errorCode}: ${frame.errorDescription}`,
          ),
        );
      }
      this.flush();
      return;
    }
    // Incoming CALL from the CSMS: record, auto-respond, notify waiters.
    this.entries.push({
      direction: "received",
      action: frame.action,
      payload: frame.payload,
      timeMs: Date.now() - this.startMs,
    });
    const response = respondToCall16(
      frame.action,
      frame.payload,
      this.responder,
    );
    this.ws?.send(encodeCallResult(frame.messageId, response));
    for (let i = 0; i < this.callWaiters.length; i++) {
      const w = this.callWaiters[i];
      if (w.actions.includes(frame.action)) {
        this.callWaiters.splice(i, 1);
        if (w.timeoutId !== null) clearTimeout(w.timeoutId);
        w.resolve({ action: frame.action, payload: frame.payload });
        break;
      }
    }
  }

  waitForCsmsCall(
    actions: readonly string[],
    timeoutMs: number | null,
  ): Promise<{ action: string; payload: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const waiter: CallWaiter = { actions, resolve, reject, timeoutId: null };
      if (timeoutMs !== null) {
        waiter.timeoutId = setTimeout(() => {
          const i = this.callWaiters.indexOf(waiter);
          if (i >= 0) this.callWaiters.splice(i, 1);
          reject(
            new Error(
              `timed out waiting for ${actions.join("/")} after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      }
      this.callWaiters.push(waiter);
    });
  }

  async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  nowIso(): string {
    return new Date().toISOString();
  }

  getLocalStatus(): string {
    return this.localStatus;
  }

  setLocalStatus(status: string): void {
    this.localStatus = status;
    for (let i = this.statusWaiters.length - 1; i >= 0; i--) {
      const w = this.statusWaiters[i];
      if (w.target === status) {
        this.statusWaiters.splice(i, 1);
        if (w.timeoutId !== null) clearTimeout(w.timeoutId);
        w.resolve();
      }
    }
  }

  waitForLocalStatus(target: string, timeoutMs: number | null): Promise<void> {
    if (this.localStatus === target) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter: StatusWaiter = { target, resolve, reject, timeoutId: null };
      if (timeoutMs !== null) {
        waiter.timeoutId = setTimeout(() => {
          const i = this.statusWaiters.indexOf(waiter);
          if (i >= 0) this.statusWaiters.splice(i, 1);
          reject(
            new Error(
              `timed out waiting for status ${target} after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      }
      this.statusWaiters.push(waiter);
    });
  }

  armResponseOverride(action: string, status: string): void {
    this.responder.armedOverrides.set(action, status);
  }

  setUnlockOutcome(outcome: string): void {
    if (
      outcome === "Unlocked" ||
      outcome === "UnlockFailed" ||
      outcome === "NotSupported"
    ) {
      this.responder.unlockOutcome = outcome;
    }
  }

  setLocalConfig(key: string, value: string): void {
    this.responder.localConfig.set(key, value);
  }

  transcript(): readonly TranscriptEntry[] {
    return this.entries;
  }

  status(): string {
    return this.localStatus;
  }

  /** Soak mode: keep the connection (heartbeats + auto-responder) alive until
   * k6 interrupts the iteration at test end. */
  async hold(): Promise<never> {
    for (;;) {
      await this.sleep(60_000);
      if (this.closed) throw new Error("connection closed during hold");
    }
  }

  close(): void {
    this.closed = true;
    if (this.heartbeatId !== null) clearInterval(this.heartbeatId);
    this.heartbeatId = null;
    this.ws?.close();
  }

  private failAll(err: Error): void {
    this.closed = true;
    if (this.heartbeatId !== null) clearInterval(this.heartbeatId);
    this.heartbeatId = null;
    const p = this.pending;
    this.pending = null;
    if (p !== null) {
      clearTimeout(p.timeoutId);
      p.reject(err);
    }
    for (const q of this.queue.splice(0)) q.reject(err);
    for (const w of this.callWaiters.splice(0)) {
      if (w.timeoutId !== null) clearTimeout(w.timeoutId);
      w.reject(err);
    }
    for (const w of this.statusWaiters.splice(0)) {
      if (w.timeoutId !== null) clearTimeout(w.timeoutId);
      w.reject(err);
    }
  }
}

function encodeCredentials(user: string, pass: string): string {
  const raw = `${user}:${pass}`;
  const table =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < raw.length; i += 3) {
    const a = raw.charCodeAt(i);
    const b = i + 1 < raw.length ? raw.charCodeAt(i + 1) : NaN;
    const c = i + 2 < raw.length ? raw.charCodeAt(i + 2) : NaN;
    out += table[a >> 2];
    out += table[((a & 3) << 4) | (Number.isNaN(b) ? 0 : b >> 4)];
    out += Number.isNaN(b)
      ? "="
      : table[((b & 15) << 2) | (Number.isNaN(c) ? 0 : c >> 6)];
    out += Number.isNaN(c) ? "=" : table[c & 63];
  }
  return out;
}
