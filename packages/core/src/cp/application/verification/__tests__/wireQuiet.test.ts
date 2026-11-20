import { describe, expect, it, vi } from "vitest";
import { Logger, LogType } from "../../../shared/Logger";
import { whenWireQuiet } from "../wireQuiet";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";

function fakeChargePoint(online = true): { cp: ChargePoint; logger: Logger } {
  const logger = new Logger();
  return {
    logger,
    cp: { logger, isOnline: () => online } as unknown as ChargePoint,
  };
}

const sent = (logger: Logger, id: string, action: string) =>
  logger.info(`Sent: [2,"${id}","${action}",{}]`, LogType.WEBSOCKET);
const received = (logger: Logger, id: string) =>
  logger.info(`Received: [3,"${id}",{}]`, LogType.WEBSOCKET);

describe("whenWireQuiet", () => {
  it("waits for frames that go out after the call, and for their answers", async () => {
    vi.useFakeTimers();
    try {
      const { cp, logger } = fakeChargePoint();
      let settled = false;
      void whenWireQuiet(cp, { quietMs: 250, maxMs: 5_000 }).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(200);
      sent(logger, "a", "DataTransfer"); // queued behind another CALL
      await vi.advanceTimersByTimeAsync(1_000);
      // Unanswered: not quiet however long the silence.
      expect(settled).toBe(false);

      received(logger, "a");
      await vi.advanceTimersByTimeAsync(249);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up at maxMs, and does not wait on a link that is down", async () => {
    vi.useFakeTimers();
    try {
      const busy = fakeChargePoint();
      let busyDone = false;
      void whenWireQuiet(busy.cp, { quietMs: 250, maxMs: 1_000 }).then(() => {
        busyDone = true;
      });
      sent(busy.logger, "x", "StatusNotification");
      await vi.advanceTimersByTimeAsync(999);
      expect(busyDone).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(busyDone).toBe(true);

      const offline = fakeChargePoint(false);
      let offlineDone = false;
      void whenWireQuiet(offline.cp, { quietMs: 250, maxMs: 5_000 }).then(
        () => {
          offlineDone = true;
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(offlineDone).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
