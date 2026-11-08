import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OCPPWebSocket } from "../OCPPWebSocket";
import { resolveReconnectPolicy } from "../ReconnectPolicy";
import type { Logger } from "../../../shared/Logger";

// #609: the reconnect loop follows the configured policy.

class FakeWebSocket {
  readyState: number = WebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  send(): void {}
  close(): void {
    this.simulateClose();
  }
  simulateOpen(): void {
    this.readyState = WebSocket.OPEN;
    this.onopen?.();
  }
  simulateClose(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.onclose?.({ code: 1006, reason: "", wasClean: false } as CloseEvent);
  }
}

const sockets: FakeWebSocket[] = [];

vi.mock("../wsUrlWithBasic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../wsUrlWithBasic")>()),
  openOcppWebSocket: (options: {
    onopen?: () => void;
    onclose?: (ev: CloseEvent) => void;
  }) => {
    const fake = new FakeWebSocket();
    fake.onopen = options.onopen ?? null;
    fake.onclose = options.onclose ?? null;
    sockets.push(fake);
    return fake;
  },
}));

const logger = (): Logger =>
  ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as unknown as Logger;
const current = () => sockets[sockets.length - 1];

describe("OCPPWebSocket reconnect policy (#609)", () => {
  let ws: OCPPWebSocket;
  let notices: { attempt: number; delayMs: number }[];
  let gaveUp: { attempts: number }[];

  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
    ws = new OCPPWebSocket("ws://localhost:8080", "CP-001", logger());
    notices = [];
    gaveUp = [];
    ws.observers.on("reconnectScheduled", (n) => notices.push(n));
    ws.observers.on("reconnectGaveUp", (g) => gaveUp.push(g));
  });

  afterEach(() => {
    ws.dispose();
    vi.useRealTimers();
  });

  /** Fail the current attempt and let the scheduled reconnect fire. */
  const failAndWait = () => {
    current().simulateClose();
    vi.advanceTimersByTime(60_000);
  };

  it("keeps 1 s doubling to 30 s without a policy", () => {
    ws.connect();
    for (let i = 0; i < 7; i++) failAndWait();
    expect(notices.map((n) => n.delayMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
    expect(gaveUp).toEqual([]);
  });

  it("uses a fixed delay", () => {
    ws.setReconnectPolicy(
      resolveReconnectPolicy({ mode: "fixed", baseDelayMs: 300 }),
    );
    ws.connect();
    for (let i = 0; i < 3; i++) failAndWait();
    expect(notices.map((n) => n.delayMs)).toEqual([300, 300, 300]);
  });

  it("gives up after maxAttempts, once, and schedules nothing more", () => {
    ws.setReconnectPolicy(resolveReconnectPolicy({ maxAttempts: 2 }));
    ws.connect();
    failAndWait();
    failAndWait();
    const opened = sockets.length;
    failAndWait();

    expect(notices.map((n) => n.attempt)).toEqual([1, 2]);
    expect(gaveUp).toEqual([{ attempts: 2 }]);
    vi.advanceTimersByTime(600_000);
    expect(sockets.length).toBe(opened);
  });

  it("announces the give-up after the close, and a later connect() has a fresh budget", () => {
    ws.setReconnectPolicy(resolveReconnectPolicy({ maxAttempts: 1 }));
    const order: string[] = [];
    ws.observers.on("reconnectGaveUp", () => order.push("gaveUp"));
    ws.connect(null, () => order.push("close"));
    failAndWait();
    failAndWait();
    expect(order.at(-2)).toBe("close");
    expect(order.at(-1)).toBe("gaveUp");

    ws.connect();
    failAndWait();
    expect(notices.map((n) => n.attempt)).toEqual([1, 1]);
  });

  it("draws jitter from the supplied random, in order", () => {
    const draws = [0, 0.5];
    ws.setReconnectPolicy(resolveReconnectPolicy({ jitterMs: 200 }), () =>
      draws.shift()!,
    );
    ws.connect();
    failAndWait();
    failAndWait();
    expect(notices.map((n) => n.delayMs)).toEqual([1000, 2100]);
  });

  it("follows the 2.x RetryBackOff variables once set", () => {
    ws.setRetryBackOff({
      waitMinimumSeconds: 10,
      randomRangeSeconds: 0,
      repeatTimes: 1,
    });
    ws.setReconnectPolicy(resolveReconnectPolicy({ maxDelayMs: 600_000 }));
    ws.connect();
    for (let i = 0; i < 3; i++) failAndWait();
    expect(notices.map((n) => n.delayMs)).toEqual([10_000, 20_000, 20_000]);
  });

  it("resets the attempt counter when a connection opens", () => {
    ws.setReconnectPolicy(resolveReconnectPolicy({ maxAttempts: 2 }));
    ws.connect();
    failAndWait();
    current().simulateOpen();
    current().simulateClose();
    expect(notices.map((n) => n.attempt)).toEqual([1, 1]);
    expect(gaveUp).toEqual([]);
  });
});
