import { describe, it, expect } from "bun:test";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";

/**
 * Issue #181 CodeRabbit follow-up: `OCPPMessageHandler.handleCallError`
 * (the v1.6 counterpart of `OCPPMessageHandlerV201`'s CALLERROR branch)
 * used to just drop the pending-request entry and log a warning, ignoring
 * `request.action`. When the CSMS answered Authorize.req with a CALLERROR
 * (e.g. FormationViolation), nothing ever resolved the in-flight
 * `ChargePoint.authorizeAndWait`, so it burned the full 10s timeout before
 * warn-and-proceeding — the exact stall issue #181 fixes for the happy
 * (CALLRESULT) path. This suite pins the wire-level fix: a CALLERROR
 * answering Authorize.req now resolves `authorizeAndWait` immediately with
 * a synthesized fail-CLOSED denial ("Invalid").
 */

async function replyStatusNotification(
  csms: MockCsms,
  connectorId: number,
  status: string,
): Promise<void> {
  const frame = await csms.waitForFrame(
    (candidate) =>
      candidate[0] === 2 &&
      candidate[2] === "StatusNotification" &&
      (candidate[3] as { connectorId?: number; status?: string })
        .connectorId === connectorId &&
      (candidate[3] as { connectorId?: number; status?: string }).status ===
        status,
  );
  csms.replyCallResult(frame[1] as string, {});
}

async function expectNoFrame(
  csms: MockCsms,
  pred: (frame: OcppFrame) => boolean,
): Promise<void> {
  try {
    const frame = await csms.waitForFrame(pred, 200);
    throw new Error(`Unexpected frame: ${JSON.stringify(frame)}`);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Timed out waiting for frame"
    ) {
      return;
    }
    throw error;
  }
}

async function connectAndBoot(csms: MockCsms, cp: ChargePoint): Promise<void> {
  cp.connect();
  const boot = await csms.waitForCall("BootNotification");
  csms.replyCallResult(boot.messageId, {
    status: "Accepted",
    currentTime: "2026-06-24T00:00:00.000Z",
    interval: 300,
  });
  // §4.1.1 serializes outgoing CALLs FIFO, so the initial post-boot
  // StatusNotifications for connectors 0 and 1 must be acked before
  // Authorize.req (issued by startTransaction below) can go out.
  await replyStatusNotification(csms, 0, "Available");
  await replyStatusNotification(csms, 1, "Available");
}

function newV16ChargePoint(id: string, url: string): ChargePoint {
  const cp = new ChargePoint(
    id,
    DefaultBootNotification,
    1,
    url,
    null,
    null,
    null,
    {},
    [],
    "OCPP-1.6J",
    {},
  );
  cp.events.on("error", () => undefined);
  // Deliberately NOT disabling AuthorizeBeforeLocalStart — this suite
  // exists specifically to exercise the gate at its real-world default.
  return cp;
}

describe("OCPP 1.6 local-authorize gate — CALLERROR handling (#181)", () => {
  it("gate ON + CSMS answers Authorize with a CALLERROR: resolves PROMPTLY (no ~10s stall) and denies fail-CLOSED", async () => {
    const csms = startMockCsms();
    const cp = newV16ChargePoint("CP016-AUTHGATE-CALLERROR", csms.url);
    const tagId = "TAG-16-AUTHGATE-CALLERROR";

    try {
      await connectAndBoot(csms, cp);

      const startedAt = Date.now();
      const startPromise = cp.startTransaction(tagId, 1);

      const authCall = await csms.waitForCall("Authorize");
      expect(authCall.payload).toEqual({ idTag: tagId });
      // OCPP-J CALLERROR: [4, messageId, errorCode, errorDescription, errorDetails]
      csms.send([
        4,
        authCall.messageId,
        "FormationViolation",
        "bad payload",
        {},
      ]);

      const outcome = await startPromise;
      const elapsedMs = Date.now() - startedAt;

      // Before this fix, handleCallError ignored request.action entirely,
      // so this only ever resolved via authorizeAndWait's 10_000ms
      // timeout. A generous 3s ceiling proves resolution rode the
      // CALLERROR, not the timeout.
      expect(elapsedMs).toBeLessThan(3000);
      // Fail-CLOSED: a CALLERROR is a definite protocol failure (unlike
      // silence, which fails open per authorizeAndWait's timeout/
      // disconnect paths), so the synthesized denial status is "Invalid"
      // and the local start does not proceed.
      expect(outcome).toEqual({ started: false, denialStatus: "Invalid" });
      expect(cp.getConnector(1)?.transaction).toBeNull();
      await expectNoFrame(
        csms,
        (frame) => frame[0] === 2 && frame[2] === "StartTransaction",
      );
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  }, 5000);
});
