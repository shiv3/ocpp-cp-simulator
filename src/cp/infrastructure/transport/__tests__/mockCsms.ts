// Test-only mock CSMS WebSocket server backed by Bun.serve.
// Imported by *.bun.test.ts files (runs under `bun test`, not vitest).
import type { ServerWebSocket } from "bun";

export type OcppFrame = unknown[];

interface FrameWaiter {
  pred: (frame: OcppFrame) => boolean;
  resolve: (frame: OcppFrame) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface MockCsms {
  url: string;
  port: number;
  received: OcppFrame[];
  waitForConnection: (timeoutMs?: number) => Promise<void>;
  waitForFrame: (pred: (f: OcppFrame) => boolean, timeoutMs?: number) => Promise<OcppFrame>;
  waitForCall: (action: string, timeoutMs?: number) => Promise<{ messageId: string; payload: unknown }>;
  replyCallResult: (messageId: string, payload: unknown) => void;
  send: (frame: OcppFrame) => void;
  stop: () => void;
}

export function startMockCsms(): MockCsms {
  const received: OcppFrame[] = [];
  const waiters = new Set<FrameWaiter>();
  let socket: ServerWebSocket<unknown> | null = null;
  let markConnected: (() => void) | null = null;
  const connected = new Promise<void>((resolve) => {
    markConnected = resolve;
  });

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
        markConnected?.();
      },
      message(_ws, message) {
        const raw = typeof message === "string" ? message : message.toString();
        const frame = JSON.parse(raw) as OcppFrame;
        received.push(frame);
        for (const w of [...waiters]) {
          if (w.pred(frame)) {
            w.resolve(frame); // resolve() removes the waiter and clears its timer
          }
        }
      },
      close() {
        socket = null;
      },
    },
  });

  function waitForFrame(pred: (f: OcppFrame) => boolean, timeoutMs = 2000): Promise<OcppFrame> {
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
    url: `ws://localhost:${server.port}/`,
    port: server.port,
    received,
    waitForConnection(timeoutMs = 2000) {
      return Promise.race([
        connected,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("Timed out waiting for connection")), timeoutMs),
        ),
      ]);
    },
    waitForFrame,
    async waitForCall(action, timeoutMs) {
      const frame = await waitForFrame((f) => f[0] === 2 && f[2] === action, timeoutMs);
      return { messageId: frame[1] as string, payload: frame[3] };
    },
    replyCallResult(messageId, payload) {
      socket?.send(JSON.stringify([3, messageId, payload]));
    },
    send(frame) {
      socket?.send(JSON.stringify(frame));
    },
    stop() {
      for (const w of [...waiters]) {
        w.reject(new Error("mock CSMS stopped")); // reject() clears the timer and removes the waiter
      }
      server.stop(true);
    },
  };
}

/** Replace volatile fields (UUID message ids, timestamps) so transcripts can be snapshotted. */
export function normalizeTranscript(frames: OcppFrame[]): OcppFrame[] {
  return frames.map((frame) =>
    frame.map((part) => {
      if (typeof part === "string" && /^[0-9a-fA-F-]{36}$/.test(part)) {
        return "<uuid>";
      }
      if (part && typeof part === "object") {
        const clone = { ...(part as Record<string, unknown>) };
        if (typeof clone.timestamp === "string") clone.timestamp = "<ts>";
        if (typeof clone.currentTime === "string") clone.currentTime = "<ts>";
        return clone;
      }
      return part;
    }),
  );
}
