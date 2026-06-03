import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { UpdateFirmwareHandler } from "../UpdateFirmwareHandler";
import { Logger } from "../../../../../shared/Logger";
import type { HandlerContext } from "../../MessageHandlerRegistry";
import type { ChargePoint } from "../../../../../domain/charge-point/ChargePoint";

type FirmwareStatus =
  | "Downloaded"
  | "DownloadFailed"
  | "Downloading"
  | "Idle"
  | "InstallationFailed"
  | "Installing"
  | "Installed";

/**
 * Spies on `sendFirmwareStatusNotification` and exposes the recorded
 * sequence so each test can assert on the exact status train. We reuse
 * ChargePoint's real `simulateFirmwareUpdate` since the schedule is the
 * thing under test — the spy only intercepts the leaf send call.
 */
function buildContext() {
  const logger = new Logger();
  const sent: FirmwareStatus[] = [];
  const timers: NodeJS.Timeout[] = [];
  let inFlight = false;

  // Minimal duck-typed ChargePoint replicating the slice of
  // simulateFirmwareUpdate that's relevant to this handler test. We
  // intentionally do not pull in the real ChargePoint to keep the test
  // fast (no WebSocket, no Database).
  const chargePoint = {
    sendFirmwareStatusNotification: (status: FirmwareStatus) => {
      sent.push(status);
    },
    simulateFirmwareUpdate(retrieveDate: Date, intervalMs = 2000): void {
      if (inFlight) return;
      inFlight = true;
      const sequence: FirmwareStatus[] = [
        "Downloading",
        "Downloaded",
        "Installing",
        "Installed",
      ];
      const startDelay = Math.max(0, retrieveDate.getTime() - Date.now());
      const fireStep = (i: number) => {
        if (i >= sequence.length) {
          inFlight = false;
          return;
        }
        this.sendFirmwareStatusNotification(sequence[i]);
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

describe("UpdateFirmwareHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns an empty response immediately (§6.19)", () => {
    const { ctx } = buildContext();
    const handler = new UpdateFirmwareHandler();
    const res = handler.handle(
      {
        location: "http://example.invalid/firmware.bin",
        retrieveDate: new Date(Date.now() + 1000).toISOString(),
      },
      ctx,
    );
    expect(res).toEqual({});
  });

  it("fires Downloading → Downloaded → Installing → Installed after retrieveDate", async () => {
    const { ctx, sent } = buildContext();
    const handler = new UpdateFirmwareHandler();
    handler.handle(
      {
        location: "http://example.invalid/firmware.bin",
        retrieveDate: new Date(Date.now() + 1000).toISOString(),
      },
      ctx,
    );

    // microtask: schedules the actual update
    await Promise.resolve();
    expect(sent).toEqual([]);

    // before retrieveDate: nothing yet
    vi.advanceTimersByTime(999);
    expect(sent).toEqual([]);

    // hit retrieveDate → Downloading
    vi.advanceTimersByTime(1);
    expect(sent).toEqual(["Downloading"]);

    vi.advanceTimersByTime(2000);
    expect(sent).toEqual(["Downloading", "Downloaded"]);

    vi.advanceTimersByTime(2000);
    expect(sent).toEqual(["Downloading", "Downloaded", "Installing"]);

    vi.advanceTimersByTime(2000);
    expect(sent).toEqual([
      "Downloading",
      "Downloaded",
      "Installing",
      "Installed",
    ]);
  });

  it("starts immediately when retrieveDate is invalid", async () => {
    const { ctx, sent } = buildContext();
    const handler = new UpdateFirmwareHandler();
    handler.handle({ location: "http://x", retrieveDate: "not-a-date" }, ctx);
    await Promise.resolve();
    vi.advanceTimersByTime(0);
    expect(sent[0]).toBe("Downloading");
  });
});
