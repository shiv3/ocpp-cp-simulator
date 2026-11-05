import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { OCPPWebSocket } from "../OCPPWebSocket";
import { Logger } from "../../../shared/Logger";

// #406: WebSocketPingInterval drives client-side ping frames.

class FakeWebSocket {
  readyState: number = WebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  ping = vi.fn();

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
    this.onclose?.(
      new CloseEvent("close", { code: 1006, reason: "", wasClean: false }),
    );
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

const createMockLogger = (): Logger =>
  ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as unknown as Logger;

const current = (): FakeWebSocket => sockets[sockets.length - 1];

describe("OCPPWebSocket WebSocketPingInterval (#406)", () => {
  let logger: Logger;
  let ws: OCPPWebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
    logger = createMockLogger();
    ws = new OCPPWebSocket("ws://localhost:8080", "CP-001", logger);
  });

  afterEach(() => {
    ws.dispose();
    vi.useRealTimers();
  });

  it("sends no ping while the interval is 0 (the default)", () => {
    ws.connect();
    current().simulateOpen();

    vi.advanceTimersByTime(120_000);

    expect(current().ping).not.toHaveBeenCalled();
  });

  it("pings every N seconds once the socket is open", () => {
    ws.connect();
    current().simulateOpen();

    ws.setPingInterval(5);
    vi.advanceTimersByTime(4_999);
    expect(current().ping).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(current().ping).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(current().ping).toHaveBeenCalledTimes(3);
  });

  it("arms on open when the interval was set before connecting", () => {
    ws.setPingInterval(5);
    ws.connect();
    vi.advanceTimersByTime(10_000);
    expect(current().ping).not.toHaveBeenCalled();

    current().simulateOpen();
    vi.advanceTimersByTime(5_000);

    expect(current().ping).toHaveBeenCalledTimes(1);
  });

  it("re-arms with the new cadence when the interval changes", () => {
    ws.connect();
    current().simulateOpen();
    ws.setPingInterval(10);
    vi.advanceTimersByTime(6_000);

    ws.setPingInterval(2);
    vi.advanceTimersByTime(4_000);

    expect(current().ping).toHaveBeenCalledTimes(2);
  });

  it("keeps the timer's phase when the same interval is set again", () => {
    ws.connect();
    current().simulateOpen();
    ws.setPingInterval(5);
    vi.advanceTimersByTime(4_000);

    ws.setPingInterval(5);
    vi.advanceTimersByTime(1_000);

    expect(current().ping).toHaveBeenCalledTimes(1);
  });

  it("stops pinging when the interval is set back to 0", () => {
    ws.connect();
    current().simulateOpen();
    ws.setPingInterval(5);
    vi.advanceTimersByTime(5_000);

    ws.setPingInterval(0);
    vi.advanceTimersByTime(60_000);

    expect(current().ping).toHaveBeenCalledTimes(1);
  });

  it("stops on close and re-arms on the reconnected socket", () => {
    ws.setPingInterval(5);
    ws.connect();
    current().simulateOpen();
    const first = current();

    first.simulateClose();
    vi.advanceTimersByTime(1_000); // first reconnect attempt
    const second = current();
    expect(second).not.toBe(first);
    vi.advanceTimersByTime(30_000);
    expect(first.ping).not.toHaveBeenCalled();
    expect(second.ping).not.toHaveBeenCalled();

    second.simulateOpen();
    vi.advanceTimersByTime(5_000);

    expect(first.ping).not.toHaveBeenCalled();
    expect(second.ping).toHaveBeenCalledTimes(1);
  });

  it("stops on a manual disconnect", () => {
    ws.setPingInterval(5);
    ws.connect();
    current().simulateOpen();

    ws.disconnect();
    vi.advanceTimersByTime(60_000);

    expect(current().ping).not.toHaveBeenCalled();
  });

  it("logs a failing ping instead of throwing out of the timer", () => {
    ws.connect();
    current().simulateOpen();
    current().ping.mockImplementation(() => {
      throw new Error("boom");
    });

    ws.setPingInterval(5);
    expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("boom"),
      expect.anything(),
    );
  });
});
