import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SignedUpdateFirmwareHandler } from "../SignedUpdateFirmwareHandler";
import { Logger } from "../../../../../shared/Logger";
import type { HandlerContext } from "../../MessageHandlerRegistry";
import type { ChargePoint } from "../../../../../domain/charge-point/ChargePoint";

type FirmwareStatus =
  | "Downloading"
  | "Downloaded"
  | "SignatureVerified"
  | "Installing"
  | "Installed";

/**
 * Spies on `sendSignedFirmwareStatusNotification` and replicates the
 * scheduling half of `ChargePoint.simulateSignedFirmwareUpdate` — the
 * schedule itself is what's under test here — same duck-typing approach
 * as `UpdateFirmwareHandler.test.ts` (no WebSocket / Database needed).
 */
function buildContext() {
  const logger = new Logger();
  const sent: Array<{ status: FirmwareStatus; requestId?: number }> = [];
  const timers: NodeJS.Timeout[] = [];
  let inFlight = false;

  const chargePoint = {
    sendSignedFirmwareStatusNotification: (
      status: FirmwareStatus,
      requestId?: number,
    ) => {
      sent.push({ status, requestId });
    },
    simulateSignedFirmwareUpdate(
      retrieveDate: Date,
      requestId: number,
      intervalMs = 2000,
    ): void {
      if (inFlight) return;
      inFlight = true;
      const sequence: FirmwareStatus[] = [
        "Downloading",
        "Downloaded",
        "SignatureVerified",
        "Installing",
        "Installed",
      ];
      const startDelay = Math.max(0, retrieveDate.getTime() - Date.now());
      const fireStep = (i: number) => {
        if (i >= sequence.length) {
          inFlight = false;
          return;
        }
        this.sendSignedFirmwareStatusNotification(sequence[i], requestId);
        timers.push(setTimeout(() => fireStep(i + 1), intervalMs));
      };
      timers.push(setTimeout(() => fireStep(0), startDelay));
    },
  };

  const ctx: HandlerContext = {
    chargePoint: chargePoint as unknown as ChargePoint,
    logger,
  };
  return { ctx, sent };
}

function firmwarePayload(
  overrides: Partial<{ retrieveDateTime: string; requestId: number }> = {},
) {
  return {
    requestId: overrides.requestId ?? 5,
    firmware: {
      location: "http://example.invalid/firmware.bin",
      retrieveDateTime:
        overrides.retrieveDateTime ?? new Date(Date.now() + 1000).toISOString(),
      signingCertificate:
        "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
      signature: "deadbeef",
    },
  };
}

describe("SignedUpdateFirmwareHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns Accepted immediately", () => {
    const { ctx } = buildContext();
    const handler = new SignedUpdateFirmwareHandler();
    const res = handler.handle(firmwarePayload(), ctx);
    expect(res).toEqual({ status: "Accepted" });
  });

  it("fires Downloading → Downloaded → SignatureVerified → Installing → Installed carrying requestId", async () => {
    const { ctx, sent } = buildContext();
    const handler = new SignedUpdateFirmwareHandler();
    handler.handle(firmwarePayload({ requestId: 9 }), ctx);

    await Promise.resolve();
    expect(sent).toEqual([]);

    vi.advanceTimersByTime(999);
    expect(sent).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(sent).toEqual([{ status: "Downloading", requestId: 9 }]);

    vi.advanceTimersByTime(2000);
    vi.advanceTimersByTime(2000);
    vi.advanceTimersByTime(2000);
    vi.advanceTimersByTime(2000);
    expect(sent).toEqual([
      { status: "Downloading", requestId: 9 },
      { status: "Downloaded", requestId: 9 },
      { status: "SignatureVerified", requestId: 9 },
      { status: "Installing", requestId: 9 },
      { status: "Installed", requestId: 9 },
    ]);
  });

  it("starts immediately when retrieveDateTime is invalid", async () => {
    const { ctx, sent } = buildContext();
    const handler = new SignedUpdateFirmwareHandler();
    handler.handle(
      firmwarePayload({ retrieveDateTime: "not-a-date", requestId: 1 }),
      ctx,
    );
    await Promise.resolve();
    vi.advanceTimersByTime(0);
    expect(sent[0]).toEqual({ status: "Downloading", requestId: 1 });
  });
});
