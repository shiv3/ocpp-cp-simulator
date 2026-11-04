import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChargePoint } from "../ChargePoint";
import { DefaultBootNotification } from "../../types/OcppTypes";
import type { OcppTlsOptions } from "../../../infrastructure/transport/wsUrlWithBasic";

/**
 * #537: a renewed Charging Station certificate that failed gets exactly one
 * more attempt once the previous certificate has opened and booted, on 2.0.1
 * and 2.1 (a deliberate departure from 2.1 A02.FR.10). A real ChargePoint and
 * transport over a scripted socket: what is pinned is the list of attempts.
 */

class FakeWebSocket {
  readyState = 0;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  send(frame: string): void {
    this.sent.push(frame);
  }

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

  /** The CSMS refused the client certificate. */
  fail(): void {
    this.readyState = 3;
    this.onclose?.(
      new CloseEvent("close", { code: 1006, reason: "", wasClean: false }),
    );
  }
}

const attempts: Array<string | undefined> = [];
const sockets: FakeWebSocket[] = [];

vi.mock(
  "../../../infrastructure/transport/wsUrlWithBasic",
  async (original) => ({
    ...(await original<object>()),
    openOcppWebSocket: (options: unknown) => {
      const opts = options as {
        tls?: OcppTlsOptions;
        onopen?: () => void;
        onclose?: (ev: CloseEvent) => void;
      };
      attempts.push(opts.tls?.cert as string | undefined);
      const ws = new FakeWebSocket();
      if (opts.onopen) ws.onopen = opts.onopen;
      if (opts.onclose) ws.onclose = opts.onclose;
      sockets.push(ws);
      return ws;
    },
    probeUpgradeRefusal: () => Promise.resolve(null),
  }),
);

const CONFIGURED = "CONFIGURED CERT";
const RENEWED = "RENEWED CERT";

function lastSocket(): FakeWebSocket {
  return sockets[sockets.length - 1]!;
}

function bootAccepted(cp: ChargePoint): void {
  cp.onBootNotificationResult({
    status: "Accepted",
    interval: 0,
    currentTime: new Date().toISOString(),
  });
}

/** Sends every frame the network simulation still holds. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe.each(["OCPP-2.0.1", "OCPP-2.1"])(
  "%s renewed certificate retry",
  (version) => {
    let cp: ChargePoint;

    beforeEach(() => {
      vi.useFakeTimers();
      attempts.length = 0;
      sockets.length = 0;
      cp = new ChargePoint(
        "CP-RETRY",
        DefaultBootNotification,
        1,
        "wss://csms.example/ocpp",
        null,
        null,
        null,
        {},
        [],
        version,
        {},
        3,
        undefined,
        undefined,
        { cert: CONFIGURED, key: "CONFIGURED KEY" },
      );
      cp.events.on("error", () => undefined);
      vi.spyOn(cp.certificateStore, "tlsClientIdentity").mockResolvedValue({
        cert: RENEWED,
        key: "RENEWED KEY",
        notBefore: new Date(0),
      });
    });

    afterEach(() => {
      cp.dispose();
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    /** Booted on --tls-cert, switched to the renewed certificate, which
     *  failed; the previous certificate's connection has just opened. */
    async function fallBack(): Promise<void> {
      cp.connect();
      lastSocket().open();
      bootAccepted(cp);
      await cp.useRenewedClientCertificate();
      expect(attempts).toEqual([CONFIGURED, RENEWED]);

      lastSocket().fail();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(attempts).toEqual([CONFIGURED, RENEWED, CONFIGURED]);
      lastSocket().open();
    }

    function discardEventSent(): boolean {
      return sockets.some((socket) =>
        socket.sent.some((frame) =>
          frame.includes("DiscardedRenewedClientCertificate"),
        ),
      );
    }

    it("retries only after the fallback connection's boot is accepted", async () => {
      await fallBack();

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(attempts).toHaveLength(3);

      bootAccepted(cp);
      expect(attempts).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(attempts).toEqual([CONFIGURED, RENEWED, CONFIGURED, RENEWED]);
    });

    it("keeps the renewed certificate when the retry opens", async () => {
      await fallBack();
      bootAccepted(cp);
      await vi.advanceTimersByTimeAsync(1_000);
      lastSocket().open();
      bootAccepted(cp);
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(attempts).toHaveLength(4);
      expect(discardEventSent()).toBe(false);
    });

    it("discards it after a failed retry, with no further attempt", async () => {
      await fallBack();
      bootAccepted(cp);
      await vi.advanceTimersByTimeAsync(1_000);
      lastSocket().fail();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(attempts).toEqual([
        CONFIGURED,
        RENEWED,
        CONFIGURED,
        RENEWED,
        CONFIGURED,
      ]);
      expect(discardEventSent()).toBe(false);

      lastSocket().open();
      bootAccepted(cp);
      await flush();
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      // Exactly one extra reconnect: this cannot loop.
      expect(attempts).toHaveLength(5);
      // DiscardedRenewedClientCertificate is a 2.1 security event only.
      expect(discardEventSent()).toBe(version === "OCPP-2.1");
    });

    it("presents the renewed certificate at the next connect after a manual disconnect", async () => {
      await fallBack();
      bootAccepted(cp);
      cp.disconnect();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(attempts).toHaveLength(3);

      cp.connect();
      expect(attempts).toEqual([CONFIGURED, RENEWED, CONFIGURED, RENEWED]);
    });

    it("does not reconnect after a release", async () => {
      await fallBack();
      bootAccepted(cp);
      cp.releaseRenewedClientCertificate();
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(attempts).toHaveLength(3);
    });
  },
);
