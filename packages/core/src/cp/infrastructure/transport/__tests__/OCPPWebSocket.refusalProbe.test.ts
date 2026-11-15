import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OCPPWebSocket } from "../OCPPWebSocket";
import type { Logger } from "../../../shared/Logger";

/**
 * #288 / #1033: when a failed attempt triggers the diagnostic GET that asks
 * the CSMS why it refused the upgrade. Bun 1.4.3 closes a refused upgrade with
 * 1002 `Expected 101 status code`; Bun 1.4.4 puts that text on the error event
 * and closes with a blank 1006 (repro/bun-1.4.x/ws-failure-causes.ts).
 */

class FakeWebSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  send(): void {}

  close(): void {
    if (this.readyState === 3) return;
    this.fail();
  }

  fail(error?: Event, close = { code: 1006, reason: "" }): void {
    if (error) this.onerror?.(error);
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { ...close, wasClean: false }));
  }
}

const sockets: FakeWebSocket[] = [];
const probe = vi.fn();

vi.mock("../wsUrlWithBasic", () => ({
  openOcppWebSocket: (options: unknown) => {
    const opts = options as {
      onopen?: () => void;
      onerror?: (ev: Event) => void;
      onclose?: (ev: CloseEvent) => void;
      onConnectOptions?: (o: unknown) => void;
    };
    opts.onConnectOptions?.({
      url: "ws://csms.example/ocpp/CP",
      protocols: [],
      headers: {},
      useNodeWsFallback: false,
    });
    const ws = new FakeWebSocket();
    if (opts.onopen) ws.onopen = opts.onopen;
    if (opts.onerror) ws.onerror = opts.onerror;
    if (opts.onclose) ws.onclose = opts.onclose;
    sockets.push(ws);
    return ws;
  },
  probeUpgradeRefusal: (options: unknown) => probe(options),
}));

function bunError(tail: string, code?: string): Event {
  const error = new Error(
    `WebSocket connection to 'ws://csms.example/ocpp/CP' failed: ${tail}`,
  );
  if (code !== undefined) Object.assign(error, { code });
  return { type: "error", message: error.message, error } as unknown as Event;
}

/** Bun 1.4.4's refused upgrade: the status is in the message only. */
const REFUSED_144 = bunError("Expected 101 status code: 401");
/** Bun 1.4.3's refused upgrade: the close says it, the error has no code. */
const LEGACY_REFUSED_CLOSE = { code: 1002, reason: "Expected 101 status code" };
/** The `ws` path reports the status itself. */
const WS_PATH_401 = {
  type: "error",
  message: "Unexpected server response: 401",
  httpStatus: 401,
} as unknown as Event;

function lastSocket(): FakeWebSocket {
  return sockets[sockets.length - 1]!;
}

describe("OCPPWebSocket refusal probe gating (#288, #1033)", () => {
  let ws: OCPPWebSocket;
  let errors: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
    probe.mockReset();
    probe.mockResolvedValue({ status: 401 });
    errors = [];
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn((message: string) => errors.push(message)),
      debug: vi.fn(),
    } as unknown as Logger;
    ws = new OCPPWebSocket("ws://csms.example/ocpp/", "CP", logger);
  });

  afterEach(() => {
    ws.dispose();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  const diagnosed = () =>
    errors.filter((l) => l.includes("diagnostic GET after the handshake"));

  it("probes a refused upgrade on Bun 1.4.4 and logs the status", async () => {
    ws.connect();
    lastSocket().fail(REFUSED_144);
    await vi.advanceTimersByTimeAsync(0);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(diagnosed()).toHaveLength(1);
    expect(diagnosed()[0]).toContain("WebSocket upgrade refused: HTTP 401");
  });

  it("still probes Bun 1.4.3's refused upgrade", async () => {
    ws.connect();
    lastSocket().fail(
      bunError("Expected 101 status code"),
      LEGACY_REFUSED_CLOSE,
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(diagnosed()).toHaveLength(1);
  });

  it.each([
    ["ECONNREFUSED", bunError("Failed to connect", "ECONNREFUSED")],
    ["ENOTFOUND", bunError("Failed to connect", "ENOTFOUND")],
    [
      "an untrusted server certificate",
      bunError(
        "TLS handshake failed: self signed",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
      ),
    ],
    [
      "a refused client certificate",
      bunError("Connection ended", "ECONNRESET"),
    ],
  ])("does not probe after %s", async (_name, error) => {
    ws.connect();
    lastSocket().fail(error);
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).not.toHaveBeenCalled();
  });

  it("does not probe a blank 1006 with no error", async () => {
    ws.connect();
    lastSocket().fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).not.toHaveBeenCalled();
  });

  it("does not probe after a manual disconnect", async () => {
    ws.connect();
    lastSocket().onerror?.(REFUSED_144);
    ws.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).not.toHaveBeenCalled();
  });

  it("does not probe when the client reported the status itself", async () => {
    ws.connect();
    lastSocket().fail(WS_PATH_401);
    await vi.advanceTimersByTimeAsync(0);

    expect(probe).not.toHaveBeenCalled();
    expect(errors).toContainEqual(
      expect.stringContaining("WebSocket upgrade refused: HTTP 401"),
    );
  });

  it("probes at most once a minute while the attempts keep failing", async () => {
    ws.connect();
    lastSocket().fail(REFUSED_144);
    ws.connect();
    lastSocket().fail(REFUSED_144);
    expect(probe).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 61_000);
    ws.connect();
    lastSocket().fail(REFUSED_144);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("is not silenced by a superseded socket's late status", async () => {
    ws.connect();
    const stale = lastSocket();
    // A second connect() while the first attempt is still pending.
    ws.connect();
    const current = lastSocket();

    // The old socket reports a status after the new attempt started.
    stale.fail(WS_PATH_401);
    current.fail(REFUSED_144);
    await vi.advanceTimersByTimeAsync(0);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(diagnosed()).toHaveLength(1);
  });

  it("is not silenced by a superseded socket on Bun 1.4.3 either", async () => {
    ws.connect();
    const stale = lastSocket();
    ws.connect();
    const current = lastSocket();

    stale.fail(WS_PATH_401);
    current.fail(undefined, LEGACY_REFUSED_CLOSE);
    await vi.advanceTimersByTimeAsync(0);

    expect(probe).toHaveBeenCalledTimes(1);
  });
});
