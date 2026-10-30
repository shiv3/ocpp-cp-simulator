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
  fail(): void {
    this.readyState = 3;
    this.onclose?.(
      new CloseEvent("close", { code: 1006, reason: "", wasClean: false }),
    );
  }
}

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
    expect(discarded).toBe(1);

    // SECOND is discarded; FIRST stays the station's identity.
    lastSocket().fail();
    expect(nextAttempt()).toBe(FIRST.cert);
    lastSocket().fail();
    expect(nextAttempt()).toBe(FIRST.cert);
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
    expect(discarded).toBe(1);

    lastSocket().fail();
    expect(nextAttempt()).toBe(CONFIGURED.cert);
    lastSocket().open();
    expect(discarded).toBe(1);
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
