// Test-only mock CSMS WebSocket server backed by Bun.serve.
// Imported by *.bun.test.ts files (runs under `bun test`, not vitest).
import type { ServerWebSocket } from "bun";

export type OcppFrame = unknown[];

export interface MockCsmsConnection {
  frames: Array<{ raw: string; receivedAt: number }>;
  openedAt: number;
  closedAt: number | null;
}

interface FrameWaiter {
  pred: (frame: OcppFrame) => boolean;
  resolve: (frame: OcppFrame) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ConnectionWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface MockCsms {
  url: string;
  port: number;
  received: OcppFrame[];
  waitForConnection: (timeoutMs?: number) => Promise<void>;
  waitForFrame: (
    pred: (f: OcppFrame) => boolean,
    timeoutMs?: number,
  ) => Promise<OcppFrame>;
  waitForCall: (
    action: string,
    timeoutMs?: number,
  ) => Promise<{ messageId: string; payload: unknown }>;
  replyCallResult: (messageId: string, payload: unknown) => void;
  send: (frame: OcppFrame) => void;
  stop: () => Promise<void>;
  closeCurrentConnection: (code?: number) => void;
  connections: () => MockCsmsConnection[];
  openCount: () => number;
  closeCount: () => number;
}

export function startMockCsms(): MockCsms {
  const received: OcppFrame[] = [];
  const waiters = new Set<FrameWaiter>();
  const connectionWaiters = new Set<ConnectionWaiter>();
  const connectionsList: MockCsmsConnection[] = [];
  let currentConnection: MockCsmsConnection | null = null;
  let openCountValue = 0;
  let closeCountValue = 0;
  let socket: ServerWebSocket<unknown> | null = null;
  let stopPromise: Promise<void> | null = null;

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) {
        return undefined;
      }
      return new Response("expected websocket upgrade", { status: 426 });
    },
    websocket: {
      open(ws) {
        socket = ws;
        // Create a new connection record
        currentConnection = {
          frames: [],
          openedAt: Date.now(),
          closedAt: null,
        };
        connectionsList.push(currentConnection);
        openCountValue++;
        for (const w of [...connectionWaiters]) {
          w.resolve(); // resolve() removes the waiter and clears its timer
        }
      },
      message(_ws, message) {
        const raw = typeof message === "string" ? message : message.toString();
        const frame = JSON.parse(raw) as OcppFrame;
        received.push(frame);
        // Add frame to current connection's transcript if a connection is open
        if (currentConnection) {
          currentConnection.frames.push({ raw, receivedAt: Date.now() });
        }
        for (const w of [...waiters]) {
          if (w.pred(frame)) {
            w.resolve(frame); // resolve() removes the waiter and clears its timer
          }
        }
      },
      close() {
        // Mark current connection as closed
        if (currentConnection) {
          currentConnection.closedAt = Date.now();
        }
        closeCountValue++;
        socket = null;
      },
    },
  });
  const port = server.port;
  if (port === undefined) {
    throw new Error("Mock CSMS server did not allocate a port");
  }

  function waitForFrame(
    pred: (f: OcppFrame) => boolean,
    timeoutMs = 2000,
  ): Promise<OcppFrame> {
    const existing = received.find(pred);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const waiter: FrameWaiter = {
        pred,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error("Timed out waiting for frame"));
        }, timeoutMs),
        resolve: (frame) => {
          clearTimeout(waiter.timer);
          waiters.delete(waiter);
          resolve(frame);
        },
        reject: (err) => {
          clearTimeout(waiter.timer);
          waiters.delete(waiter);
          reject(err);
        },
      };
      waiters.add(waiter);
    });
  }

  return {
    url: `ws://localhost:${port}/`,
    port,
    received,
    waitForConnection(timeoutMs = 2000) {
      if (socket) {
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        const waiter: ConnectionWaiter = {
          timer: setTimeout(() => {
            connectionWaiters.delete(waiter);
            reject(new Error("Timed out waiting for connection"));
          }, timeoutMs),
          resolve: () => {
            clearTimeout(waiter.timer);
            connectionWaiters.delete(waiter);
            resolve();
          },
          reject: (err) => {
            clearTimeout(waiter.timer);
            connectionWaiters.delete(waiter);
            reject(err);
          },
        };
        connectionWaiters.add(waiter);
      });
    },
    waitForFrame,
    async waitForCall(action, timeoutMs) {
      const frame = await waitForFrame(
        (f) => f[0] === 2 && f[2] === action,
        timeoutMs,
      );
      return { messageId: frame[1] as string, payload: frame[3] };
    },
    replyCallResult(messageId, payload) {
      socket?.send(JSON.stringify([3, messageId, payload]));
    },
    send(frame) {
      socket?.send(JSON.stringify(frame));
    },
    closeCurrentConnection(code?: number) {
      if (socket) {
        socket.close(code);
      }
    },
    connections() {
      return [...connectionsList];
    },
    openCount() {
      return openCountValue;
    },
    closeCount() {
      return closeCountValue;
    },
    async stop() {
      // Idempotent: tests stop mid-body to assert waiter rejection and then
      // stop again in cleanup. A second `server.stop(true)` never settles, so
      // the first call's promise is what every later caller awaits.
      if (stopPromise) return stopPromise;
      for (const w of [...waiters]) {
        w.reject(new Error("mock CSMS stopped")); // reject() clears the timer and removes the waiter
      }
      for (const w of [...connectionWaiters]) {
        w.reject(new Error("mock CSMS stopped")); // reject() clears the timer and removes the waiter
      }
      // Bun 1.3: if the server closed a WebSocket itself (closeCurrentConnection),
      // `server.stop()` tears the listener down immediately but its promise
      // never settles. Awaiting it verbatim wedges test cleanup, so cap the
      // wait — by the time it elapses the port is already free.
      stopPromise = Promise.race([
        server.stop(true),
        new Promise<void>((resolve) => setTimeout(resolve, 50)),
      ]);
      await stopPromise;
    },
  };
}

const UUID_RE = /^[0-9a-fA-F-]{36}$/;
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function normalizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (UUID_RE.test(value)) return "<uuid>";
    if (ISO_TIMESTAMP_RE.test(value)) return "<ts>";
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }

  if (value && typeof value === "object") {
    const clone: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>,
    )) {
      clone[key] = key === "seqNo" ? nested : normalizeValue(nested);
    }
    return clone;
  }

  return value;
}

/** Replace volatile fields (UUID message ids, timestamps) so transcripts can be snapshotted. */
export function normalizeTranscript(frames: OcppFrame[]): OcppFrame[] {
  return frames.map((frame) => normalizeValue(frame) as OcppFrame);
}
