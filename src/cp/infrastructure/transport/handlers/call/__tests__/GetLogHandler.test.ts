import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GetLogHandler } from "../GetLogHandler";
import { Logger } from "../../../../../shared/Logger";
import type { HandlerContext } from "../../MessageHandlerRegistry";
import type { ChargePoint } from "../../../../../domain/charge-point/ChargePoint";

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
  const chargePoint = {
    id: "CP-LOG-TEST",
    sendLogStatusNotification: (status: LogStatus, requestId?: number) => {
      sent.push({ status, requestId });
    },
  };
  const ctx: HandlerContext = {
    chargePoint: chargePoint as unknown as ChargePoint,
    logger: new Logger(),
  };
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
    expect(res).toEqual({
      status: "Accepted",
      filename: "CP-LOG-TEST-DiagnosticsLog-7.log",
    });
  });

  it("emits Uploading then Uploaded carrying requestId, after the CALLRESULT microtask", async () => {
    const { ctx, sent } = buildContext();
    const handler = new GetLogHandler();
    handler.handle(
      {
        logType: "SecurityLog",
        requestId: 42,
        log: { remoteLocation: "http://example.invalid/upload" },
      },
      ctx,
    );

    expect(sent).toEqual([]);
    await Promise.resolve();
    expect(sent).toEqual([{ status: "Uploading", requestId: 42 }]);

    vi.advanceTimersByTime(2000);
    expect(sent).toEqual([
      { status: "Uploading", requestId: 42 },
      { status: "Uploaded", requestId: 42 },
    ]);
  });
});
