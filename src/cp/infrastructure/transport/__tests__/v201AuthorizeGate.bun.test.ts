import { describe, it, expect } from "bun:test";
import type {
  AuthorizeRequestV201,
  TransactionEventRequestV201,
} from "../../../../ocpp";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../domain/types/OcppTypes";

/**
 * Issue #181 (review follow-up): the local-authorize gate in
 * `ChargePoint.startTransaction` defaults ON for every OCPP version, but
 * until this fix `OCPPMessageHandlerV201.handleCallResult` never correlated
 * Authorize.conf back to the ChargePoint — it only handled BootNotification.
 * Every v201 local start therefore always burned the full 10s
 * `authorizeAndWait` timeout and then proceeded as "Accepted" regardless of
 * what the CSMS actually said.
 *
 * Every OTHER v201 bun suite disables the gate
 * (`AuthorizeBeforeLocalStart=false`) specifically to dodge this — that's
 * what let the bug hide. This suite is the one place it must stay at its
 * real-world default (true) and exercise the actual wire correlation via
 * the mock CSMS, not the `notifyAuthorizeResult` test seam.
 */

function transactionEventFrame(
  eventType: TransactionEventRequestV201["eventType"],
): (frame: OcppFrame) => boolean {
  return (frame) =>
    frame[0] === 2 &&
    frame[2] === "TransactionEvent" &&
    (frame[3] as { eventType?: string }).eventType === eventType;
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
  await csms.waitForFrame(
    (frame) =>
      frame[0] === 2 &&
      frame[2] === "StatusNotification" &&
      (frame[3] as { evseId?: number; connectorId?: number }).evseId === 1 &&
      (frame[3] as { evseId?: number; connectorId?: number }).connectorId === 1,
  );
}

function newV201ChargePoint(id: string, url: string): ChargePoint {
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
    "OCPP-2.0.1",
    {},
  );
  cp.events.on("error", () => undefined);
  // Deliberately NOT disabling AuthorizeBeforeLocalStart here (every other
  // v201 bun suite does) — this suite exists specifically to exercise the
  // gate at its real default.
  return cp;
}

describe("OCPP 2.0.1 local-authorize gate (#181)", () => {
  it("gate ON + CSMS Accepts: sends Authorize.req and starts PROMPTLY (no ~10s stall)", async () => {
    const csms = startMockCsms();
    const cp = newV201ChargePoint("CP201-AUTHGATE-OK", csms.url);
    const tagId = "TAG-201-AUTHGATE-OK";

    try {
      await connectAndBoot(csms, cp);

      const startedAt = Date.now();
      const startPromise = cp.startTransaction(tagId, 1);

      const authCall = await csms.waitForCall("Authorize");
      expect(authCall.payload).toEqual({
        idToken: { idToken: tagId, type: "ISO14443" },
      } satisfies AuthorizeRequestV201);
      csms.replyCallResult(authCall.messageId, {
        idTokenInfo: { status: "Accepted" },
      });

      const outcome = await startPromise;
      const elapsedMs = Date.now() - startedAt;

      expect(outcome).toEqual({ started: true });
      // authorizeAndWait's default timeout is 10_000ms. Before this fix,
      // handleCallResult never correlated Authorize.conf, so this only
      // ever resolved via that timeout. A generous 3s ceiling proves
      // resolution rode the immediate Authorize.conf, not the timeout.
      expect(elapsedMs).toBeLessThan(3000);

      const startedFrame = await csms.waitForFrame(
        transactionEventFrame("Started"),
      );
      expect((startedFrame[3] as TransactionEventRequestV201).idToken).toEqual({
        idToken: tagId,
        type: "ISO14443",
      });
      expect(cp.getConnector(1)?.transaction).not.toBeNull();
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  }, 5000);

  it("gate ON + CSMS denies (Blocked): no transaction starts", async () => {
    const csms = startMockCsms();
    const cp = newV201ChargePoint("CP201-AUTHGATE-BLOCKED", csms.url);
    const tagId = "TAG-201-AUTHGATE-BLOCKED";

    try {
      await connectAndBoot(csms, cp);

      const startPromise = cp.startTransaction(tagId, 1);

      const authCall = await csms.waitForCall("Authorize");
      csms.replyCallResult(authCall.messageId, {
        idTokenInfo: { status: "Blocked" },
      });

      const outcome = await startPromise;

      expect(outcome).toEqual({ started: false, denialStatus: "Blocked" });
      expect(cp.getConnector(1)?.transaction).toBeNull();
      await expectNoFrame(csms, transactionEventFrame("Started"));
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });

  it("gate ON + CSMS denies (Invalid): no transaction starts", async () => {
    const csms = startMockCsms();
    const cp = newV201ChargePoint("CP201-AUTHGATE-INVALID", csms.url);
    const tagId = "TAG-201-AUTHGATE-INVALID";

    try {
      await connectAndBoot(csms, cp);

      const startPromise = cp.startTransaction(tagId, 1);

      const authCall = await csms.waitForCall("Authorize");
      csms.replyCallResult(authCall.messageId, {
        idTokenInfo: { status: "Invalid" },
      });

      const outcome = await startPromise;

      expect(outcome).toEqual({ started: false, denialStatus: "Invalid" });
      expect(cp.getConnector(1)?.transaction).toBeNull();
      await expectNoFrame(csms, transactionEventFrame("Started"));
    } finally {
      cp.disconnect();
      await csms.stop();
    }
  });
});
