import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OCPPWebSocket } from "../OCPPWebSocket";
import {
  DEFAULT_AFFINITY_FAILOVER_THRESHOLD,
  SupervisionUrlPool,
} from "../SupervisionUrlPool";
import { Logger } from "../../../shared/Logger";

/**
 * Minimal socket whose `close()` actually fires `onclose`, which is what makes
 * `handleClose()` run. A test that only calls `disconnectInternal()` on a
 * socket-less transport asserts nothing: no close event is emitted, the
 * failure branch never executes, and the assertions hold whether or not the
 * self-requested-close guard is there at all.
 */
class FakeWebSocket {
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  send(): void {}

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.(
      new CloseEvent("close", { code: 1000, reason: "", wasClean: true }),
    );
  }

  /** A close nobody asked for — a dropped link. */
  simulateNetworkClose(): void {
    this.readyState = 3;
    this.onclose?.(
      new CloseEvent("close", {
        code: 1006,
        reason: "abnormal",
        wasClean: false,
      }),
    );
  }
}

vi.mock("../wsUrlWithBasic", () => ({
  openOcppWebSocket: (options: unknown) => {
    const opts = options as {
      onopen?: () => void;
      onclose?: (ev: CloseEvent) => void;
      onmessage?: (ev: MessageEvent) => void;
      onerror?: (ev: Event) => void;
    };
    const ws = new FakeWebSocket();
    if (opts.onopen) ws.onopen = opts.onopen;
    if (opts.onmessage) ws.onmessage = opts.onmessage;
    if (opts.onerror) ws.onerror = opts.onerror;
    if (opts.onclose) ws.onclose = opts.onclose;
    return ws;
  },
  probeUpgradeRefusal: () => Promise.resolve(null),
}));

const URLS = ["ws://a/ocpp/", "ws://b/ocpp/", "ws://c/ocpp/"];

function socketOf(ws: OCPPWebSocket): FakeWebSocket {
  return (ws as unknown as { _ws: FakeWebSocket })._ws;
}

describe("supervision URL failover counts only genuine failures (#296)", () => {
  let logger: Logger;
  let ws: OCPPWebSocket;
  let pool: SupervisionUrlPool;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;
    ws = new OCPPWebSocket(URLS[0]!, "CP-001", logger);
    pool = new SupervisionUrlPool(URLS, "cp-affinity", "CP-001");
    ws.setSupervisionUrlPool(pool);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  /**
   * Close the socket the given way, once per iteration, **without** a
   * successful open in between: a success resets an affinity pool to its
   * primary, which would mask whether the closes were counted at all.
   */
  function cycle(
    kind: "network" | "reset" | "simulated" | "manual",
    times: number,
  ): void {
    for (let i = 0; i < times; i++) {
      ws.connect();
      if (kind === "network") socketOf(ws).simulateNetworkClose();
      else if (kind === "reset") ws.disconnectInternal();
      else if (kind === "simulated") ws.simulateConnectionLoss(0);
      else ws.disconnect();
    }
  }

  it("moves off the primary when the link genuinely drops", () => {
    // The control case: without this, the tests below would pass simply
    // because nothing ever moves the pool.
    const primary = pool.current();
    cycle("network", DEFAULT_AFFINITY_FAILOVER_THRESHOLD);
    expect(pool.next()).not.toBe(primary);
  });

  it("stays on the primary across resets", () => {
    // `disconnectInternal()` is what `ChargePoint.reset()` calls. It leaves
    // `_isManualDisconnect` false so the reconnect loop still runs, which is
    // exactly why it landed in the failure branch before the guard existed.
    const primary = pool.current();
    cycle("reset", DEFAULT_AFFINITY_FAILOVER_THRESHOLD + 2);
    expect(pool.next()).toBe(primary);
  });

  it("stays on the primary across injected disconnects", () => {
    // Network simulation targets the link, not the node. Counting it would
    // scatter an affinity fleet off its assigned nodes because of a test
    // artifact the fleet applied to itself.
    const primary = pool.current();
    cycle("simulated", DEFAULT_AFFINITY_FAILOVER_THRESHOLD + 2);
    expect(pool.next()).toBe(primary);
  });

  it("stays on the primary across an operator disconnect", () => {
    const primary = pool.current();
    cycle("manual", DEFAULT_AFFINITY_FAILOVER_THRESHOLD + 2);
    expect(pool.next()).toBe(primary);
  });

  it("returns to the primary once a connection succeeds", () => {
    const primary = pool.current();
    cycle("network", DEFAULT_AFFINITY_FAILOVER_THRESHOLD);
    // `current()` is the URL the last attempt used; the failover shows on the
    // next selection, not retroactively on the one that failed.
    expect(pool.next()).not.toBe(primary);

    ws.connect();
    socketOf(ws).onopen?.();
    expect(pool.next()).toBe(primary);
  });
});
