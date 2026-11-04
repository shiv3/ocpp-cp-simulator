import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OCPPWebSocket } from "../OCPPWebSocket";
import type { OcppTlsOptions } from "../wsUrlWithBasic";
import { Logger } from "../../../shared/Logger";

/**
 * #537 A02.FR.08 / A02.FR.10 / A02.FR.28: which client certificate each
 * connection attempt presents once a renewed Charging Station certificate
 * is handed to the transport, read from the TLS options passed to the
 * socket factory.
 */

class FakeWebSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  send(): void {}

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.(
      new CloseEvent("close", { code: 1000, reason: "", wasClean: true }),
    );
  }

  /** The handshake failed (the CSMS refused the client certificate). */
  fail(close: { code: number; reason: string } = NO_REASON): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { ...close, wasClean: false }));
  }
}

const NO_REASON = { code: 1006, reason: "" };

const attempts: Array<OcppTlsOptions | undefined> = [];
const sockets: FakeWebSocket[] = [];

vi.mock("../wsUrlWithBasic", () => ({
  openOcppWebSocket: (options: unknown) => {
    const opts = options as {
      tls?: OcppTlsOptions;
      onopen?: () => void;
      onclose?: (ev: CloseEvent) => void;
      onConnectOptions?: (o: unknown) => void;
    };
    attempts.push(opts.tls);
    opts.onConnectOptions?.({
      url: "wss://csms.example/ocpp/CP",
      protocols: [],
      headers: {},
      tls: opts.tls,
      useNodeWsFallback: false,
    });
    const ws = new FakeWebSocket();
    if (opts.onopen) ws.onopen = opts.onopen;
    if (opts.onclose) ws.onclose = opts.onclose;
    sockets.push(ws);
    return ws;
  },
  probeUpgradeRefusal: () => Promise.resolve(null),
}));

const CONFIGURED = { cert: "CONFIGURED CERT", key: "CONFIGURED KEY" };
const FIRST = { cert: "FIRST RENEWED CERT", key: "FIRST RENEWED KEY" };
const SECOND = { cert: "SECOND RENEWED CERT", key: "SECOND RENEWED KEY" };

function presented(tls: OcppTlsOptions | undefined): string | undefined {
  return tls?.cert as string | undefined;
}

function lastSocket(): FakeWebSocket {
  return sockets[sockets.length - 1]!;
}

describe("OCPPWebSocket renewed client certificate (#537)", () => {
  let ws: OCPPWebSocket;
  let discarded: number;

  beforeEach(() => {
    vi.useFakeTimers();
    attempts.length = 0;
    sockets.length = 0;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as Logger;
    ws = new OCPPWebSocket(
      "wss://csms.example/ocpp/",
      "CP",
      logger,
      null,
      {},
      [],
      "OCPP-2.1",
      3,
      undefined,
      undefined,
      { ca: "CA", ...CONFIGURED },
    );
    discarded = 0;
    ws.observers.on("renewedClientCertificateDiscarded", () => discarded++);
  });

  afterEach(() => {
    ws.dispose();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  /** Opens a connection and switches it to `identity`, confirmed. */
  function rotateTo(identity: { cert: string; key: string }): void {
    ws.useRenewedClientCertificate(identity);
    ws.disconnectInternal();
    ws.connect();
    expect(presented(attempts[attempts.length - 1])).toBe(identity.cert);
    lastSocket().open();
  }

  /** What `ChargePoint.reset()` does to the transport. */
  function reconnectForRetry(): void {
    ws.disconnectInternal();
    ws.connect();
  }

  /** Lets the reconnect back-off run and returns the next attempt's cert. */
  function nextAttempt(): string | undefined {
    const before = attempts.length;
    vi.advanceTimersByTime(10 * 60_000);
    expect(attempts.length).toBe(before + 1);
    return presented(attempts[attempts.length - 1]);
  }

  it("keeps the CA and server settings and presents the renewed pair", () => {
    ws.connect();
    lastSocket().open();
    rotateTo(FIRST);
    expect(attempts[attempts.length - 1]).toEqual({ ca: "CA", ...FIRST });
  });

  it("falls back to the identity confirmed before, not --tls-cert, on a second rotation (A02.FR.28)", () => {
    ws.connect();
    lastSocket().open();
    rotateTo(FIRST);

    ws.useRenewedClientCertificate(SECOND);
    ws.disconnectInternal();
    ws.connect();
    expect(presented(attempts[attempts.length - 1])).toBe(SECOND.cert);
    lastSocket().fail();

    // The certificate in use before the renewal, not the configured one.
    expect(nextAttempt()).toBe(FIRST.cert);
    lastSocket().fail();
    expect(nextAttempt()).toBe(SECOND.cert);
  });

  it("keeps the previously confirmed identity when the old one connects first (A02.FR.10)", () => {
    ws.connect();
    lastSocket().open();
    rotateTo(FIRST);

    ws.useRenewedClientCertificate(SECOND);
    ws.disconnectInternal();
    ws.connect();
    lastSocket().fail();
    expect(nextAttempt()).toBe(FIRST.cert);
    lastSocket().open();
    expect(discarded).toBe(0);
    // SECOND's one further attempt fails too.
    reconnectForRetry();
    expect(presented(attempts[attempts.length - 1])).toBe(SECOND.cert);
    lastSocket().fail();
    expect(nextAttempt()).toBe(FIRST.cert);
    lastSocket().open();
    expect(discarded).toBe(1);

    // SECOND is discarded; FIRST stays the station's identity.
    lastSocket().fail();
    expect(nextAttempt()).toBe(FIRST.cert);
    lastSocket().fail();
    expect(nextAttempt()).toBe(FIRST.cert);
  });

  describe("an attempt that never reached the CSMS", () => {
    // Bun's close for a refused connection and for a DNS failure, measured
    // in tlsSecurityProfiles.bun.test.ts. The `ws` path is made to match.
    const UNREACHABLE = { code: 1006, reason: "Failed to connect" };

    function switchToFirst(): void {
      ws.connect();
      lastSocket().open();
      ws.useRenewedClientCertificate(FIRST);
      ws.disconnectInternal();
      ws.connect();
      expect(presented(attempts[attempts.length - 1])).toBe(FIRST.cert);
    }

    it("keeps presenting the renewed certificate until the CSMS is back", () => {
      switchToFirst();

      lastSocket().fail(UNREACHABLE);
      expect(nextAttempt()).toBe(FIRST.cert);
      lastSocket().fail(UNREACHABLE);
      expect(nextAttempt()).toBe(FIRST.cert);
      lastSocket().open();

      expect(discarded).toBe(0);
      lastSocket().fail();
      expect(nextAttempt()).toBe(FIRST.cert);
    });

    it("does not turn back to the renewed certificate once it failed against the CSMS", () => {
      switchToFirst();
      lastSocket().fail();
      expect(nextAttempt()).toBe(CONFIGURED.cert);

      lastSocket().fail(UNREACHABLE);
      expect(nextAttempt()).toBe(CONFIGURED.cert);
    });

    it.each([
      [
        "a TLS handshake failure",
        { code: 1015, reason: "TLS handshake failed" },
      ],
      // Bun's close when the CSMS refuses the client certificate.
      ["a connection ended", { code: 1006, reason: "Connection ended" }],
      // Bun hides the status, which may be a refusal of the certificate.
      ["a refused upgrade", { code: 1002, reason: "Expected 101 status code" }],
      ["a close that gives no reason", NO_REASON],
    ])("still alternates after %s (A02.FR.28)", (_name, close) => {
      switchToFirst();
      lastSocket().fail(close);
      expect(nextAttempt()).toBe(CONFIGURED.cert);
    });
  });

  it("reports a discarded renewed certificate once (A02.FR.29)", () => {
    ws.connect();
    lastSocket().open();
    ws.useRenewedClientCertificate(FIRST);
    ws.disconnectInternal();
    ws.connect();
    lastSocket().fail();
    expect(nextAttempt()).toBe(CONFIGURED.cert);
    lastSocket().open();
    reconnectForRetry();
    lastSocket().fail();
    expect(nextAttempt()).toBe(CONFIGURED.cert);
    lastSocket().open();
    expect(discarded).toBe(1);

    lastSocket().fail();
    expect(nextAttempt()).toBe(CONFIGURED.cert);
    lastSocket().open();
    expect(discarded).toBe(1);
  });

  // #537: a deliberate departure from 2.1 A02.FR.10. The previous
  // certificate opening shows the CSMS is reachable, so a further failure
  // of the renewed one means something; the first one may not have.
  describe("the one further attempt once the previous certificate opened", () => {
    /** Connected, then FIRST failed and the previous certificate opened. */
    function fallBack(): void {
      ws.connect();
      lastSocket().open();
      ws.useRenewedClientCertificate(FIRST);
      ws.disconnectInternal();
      ws.connect();
      lastSocket().fail();
      expect(nextAttempt()).toBe(CONFIGURED.cert);
      lastSocket().open();
    }

    it("does not discard the renewed certificate yet, and presents it next", () => {
      fallBack();
      expect(discarded).toBe(0);
      expect(ws.renewedClientCertificateAwaitsAttempt()).toBe(true);

      reconnectForRetry();
      expect(presented(attempts[attempts.length - 1])).toBe(FIRST.cert);
    });

    it("leaves the reconnect to the caller", () => {
      fallBack();
      const before = attempts.length;
      vi.advanceTimersByTime(10 * 60_000);
      expect(attempts.length).toBe(before);
    });

    it("confirms the renewed certificate when that attempt opens", () => {
      fallBack();
      reconnectForRetry();
      lastSocket().open();

      expect(discarded).toBe(0);
      expect(ws.renewedClientCertificateAwaitsAttempt()).toBe(false);
      // Confirmed: a later failure no longer turns back to the previous one.
      lastSocket().fail();
      expect(nextAttempt()).toBe(FIRST.cert);
    });

    it("discards it when that attempt fails too, with no attempt after that", () => {
      fallBack();
      reconnectForRetry();
      lastSocket().fail();
      expect(discarded).toBe(0);
      expect(nextAttempt()).toBe(CONFIGURED.cert);
      expect(discarded).toBe(0);

      lastSocket().open();
      expect(discarded).toBe(1);
      expect(ws.renewedClientCertificateAwaitsAttempt()).toBe(false);

      lastSocket().fail();
      expect(nextAttempt()).toBe(CONFIGURED.cert);
      lastSocket().fail();
      expect(nextAttempt()).toBe(CONFIGURED.cert);
      expect(discarded).toBe(1);
    });

    it("uses that attempt on the next connection if the fallback one drops first", () => {
      fallBack();
      lastSocket().fail();
      expect(nextAttempt()).toBe(FIRST.cert);
      expect(ws.renewedClientCertificateAwaitsAttempt()).toBe(true);

      lastSocket().fail();
      expect(nextAttempt()).toBe(CONFIGURED.cert);
      lastSocket().open();
      expect(discarded).toBe(1);
    });

    it("does not count that attempt when it reaches no server", () => {
      fallBack();
      reconnectForRetry();
      lastSocket().fail({ code: 1006, reason: "Failed to connect" });
      expect(nextAttempt()).toBe(FIRST.cert);
      lastSocket().open();
      expect(discarded).toBe(0);
    });

    it("gives a newer renewal its own attempt", () => {
      fallBack();
      ws.useRenewedClientCertificate(SECOND);

      reconnectForRetry();
      expect(presented(attempts[attempts.length - 1])).toBe(SECOND.cert);
      lastSocket().fail();
      expect(nextAttempt()).toBe(CONFIGURED.cert);
      lastSocket().open();
      expect(discarded).toBe(0);

      reconnectForRetry();
      expect(presented(attempts[attempts.length - 1])).toBe(SECOND.cert);
      lastSocket().fail();
      expect(nextAttempt()).toBe(CONFIGURED.cert);
      lastSocket().open();
      expect(discarded).toBe(1);
    });

    it("presents the configured certificate once the identity is cleared", () => {
      fallBack();
      ws.clearRenewedClientCertificate();
      expect(ws.renewedClientCertificateAwaitsAttempt()).toBe(false);

      reconnectForRetry();
      expect(presented(attempts[attempts.length - 1])).toBe(CONFIGURED.cert);
      lastSocket().open();
      expect(discarded).toBe(0);
    });

    it("keeps a renewal handed over while the previous certificate connects", () => {
      ws.connect();
      expect(presented(attempts[0])).toBe(CONFIGURED.cert);
      ws.useRenewedClientCertificate(FIRST);
      lastSocket().open();
      expect(discarded).toBe(0);

      reconnectForRetry();
      expect(presented(attempts[attempts.length - 1])).toBe(FIRST.cert);
      lastSocket().fail();
      expect(nextAttempt()).toBe(CONFIGURED.cert);
      lastSocket().open();
      // Its own further attempt is still to come.
      expect(discarded).toBe(0);
      reconnectForRetry();
      expect(presented(attempts[attempts.length - 1])).toBe(FIRST.cert);
    });
  });

  it("does not report a discard when the renewed certificate connects", () => {
    ws.connect();
    lastSocket().open();
    rotateTo(FIRST);
    expect(discarded).toBe(0);
  });

  it("drops a renewed identity, confirmed or not, on clearRenewedClientCertificate", () => {
    ws.connect();
    lastSocket().open();
    rotateTo(FIRST);
    ws.useRenewedClientCertificate(SECOND);

    ws.clearRenewedClientCertificate();

    // The refusal probe replays the last handshake: its key is gone too.
    const last = (
      ws as unknown as { _lastConnectOptions: { tls?: OcppTlsOptions } }
    )._lastConnectOptions;
    expect(last.tls).toEqual({ ca: "CA", ...CONFIGURED });

    ws.disconnectInternal();
    ws.connect();
    expect(presented(attempts[attempts.length - 1])).toBe(CONFIGURED.cert);
  });
});
