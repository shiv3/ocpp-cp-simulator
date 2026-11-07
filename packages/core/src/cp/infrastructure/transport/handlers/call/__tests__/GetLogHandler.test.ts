import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GetLogHandler } from "../GetLogHandler";
import { Logger } from "../../../../../shared/Logger";
import type { HandlerContext } from "../../MessageHandlerRegistry";
import { ChargePoint } from "../../../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../../../domain/types/OcppTypes";
import { isHandlerOutcome } from "../../../network-sim/ResponseEffectQueue";

type LogStatus =
  | "BadMessage"
  | "Idle"
  | "NotSupportedOperation"
  | "PermissionDenied"
  | "Uploaded"
  | "UploadFailure"
  | "Uploading";

function buildContext() {
  const sent: Array<{ status: LogStatus; requestId?: number }> = [];
  const chargePoint = new ChargePoint(
    "CP-LOG-TEST",
    DefaultBootNotification,
    1,
    "ws://localhost:8080",
    null,
    null,
    null,
    {},
    [],
    "OCPP-1.6J",
    {},
  );
  vi.spyOn(chargePoint, "sendLogStatusNotification").mockImplementation(
    (status, requestId) => {
      sent.push({ status: status as LogStatus, requestId });
    },
  );
  const ctx: HandlerContext = { chargePoint, logger: new Logger() };
  return { ctx, sent };
}

describe("GetLogHandler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns Accepted with a derived filename immediately", () => {
    const { ctx } = buildContext();
    const handler = new GetLogHandler();
    const res = handler.handle(
      {
        logType: "DiagnosticsLog",
        requestId: 7,
        log: { remoteLocation: "http://example.invalid/upload" },
      },
      ctx,
    );
    expect(isHandlerOutcome(res)).toBe(true);
    if (isHandlerOutcome(res)) {
      expect(res.payload).toEqual({
        status: "Accepted",
        filename: "CP-LOG-TEST-DiagnosticsLog-7.log",
      });
    }
  });

  it("emits Uploading then Uploaded carrying requestId, after the CALLRESULT", async () => {
    const { ctx, sent } = buildContext();
    const handler = new GetLogHandler();
    const res = handler.handle(
      {
        logType: "SecurityLog",
        requestId: 42,
        log: { remoteLocation: "http://example.invalid/upload" },
      },
      ctx,
    );
    expect(isHandlerOutcome(res)).toBe(true);
    if (isHandlerOutcome(res)) {
      expect(sent).toEqual([]);
      // Invoke the effect to trigger the upload sequence
      res.afterResponseSettled();
      expect(sent).toEqual([{ status: "Uploading", requestId: 42 }]);

      await vi.advanceTimersByTimeAsync(1999);
      expect(sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toEqual([
        { status: "Uploading", requestId: 42 },
        { status: "Uploaded", requestId: 42 },
      ]);
    }
  });

  it("stops the sequence when the connection closes before the upload ends", () => {
    const { ctx, sent } = buildContext();
    const res = new GetLogHandler().handle(
      {
        logType: "SecurityLog",
        requestId: 3,
        log: { remoteLocation: "http://x" },
      },
      ctx,
    );
    if (!isHandlerOutcome(res)) throw new Error("expected an outcome");
    res.afterResponseSettled();
    ctx.chargePoint.disconnect();
    vi.advanceTimersByTime(10_000);
    expect(sent).toEqual([{ status: "Uploading", requestId: 3 }]);
  });
});
