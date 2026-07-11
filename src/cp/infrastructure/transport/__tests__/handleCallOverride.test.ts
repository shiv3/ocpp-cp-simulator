import { describe, expect, it } from "vitest";

import { OCPPMessageHandler } from "../OCPPMessageHandler";
import type { OCPPWebSocket, OcppMessageErrorPayload } from "../OCPPWebSocket";
import type { ProtocolCodec } from "../profile/ProtocolProfile";
import { outgoingV16Warning } from "../codec/validateV16";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import {
  DefaultBootNotification,
  OCPPAction,
  OCPPMessageType,
} from "../../../domain/types/OcppTypes";
import { Logger, LogLevel } from "../../../shared/Logger";

function newChargePoint(id: string): ChargePoint {
  const cp = new ChargePoint(
    id,
    DefaultBootNotification,
    1,
    "ws://127.0.0.1:9/",
    null,
    null,
    null,
    {},
    [],
    "OCPP-1.6J",
    {},
  );
  cp.events.on("error", () => undefined);
  return cp;
}

async function waitUntil(predicate: () => boolean, ms = 500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) {
      throw new Error("Timed out waiting for predicate");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// Matches the private `MessageHandler` type in OCPPWebSocket.ts — the
// callback OCPPMessageHandler registers via `setMessageHandler` and that
// production code invokes once a frame has been parsed off the wire.
type IncomingMessageHandler = (
  messageType: OCPPMessageType,
  messageId: string,
  action: OCPPAction,
  payload: unknown,
) => void;

describe("OCPPMessageHandler.handleCall response override dispatch (issue #110)", () => {
  it("fires incomingCallReceived before responding, honors a one-shot override, then falls through to the normal handler", async () => {
    const cp = newChargePoint("CP-HANDLE-CALL");
    const logger = new Logger(LogLevel.ERROR);
    // Reuse the real v16 outbound-warning logic (see profile/profiles.ts) —
    // it's a pure function, cheap to wire up directly rather than faking it.
    const codec: ProtocolCodec = { outgoingWarning: outgoingV16Warning };

    let capturedHandler: IncomingMessageHandler | null = null;
    const order: string[] = [];
    const sendResultCalls: Array<{ messageId: string; payload: unknown }> = [];
    const sendErrorCalls: Array<{
      messageId: string;
      payload: OcppMessageErrorPayload;
    }> = [];

    // Duck-typed fake: OCPPMessageHandler only ever touches these four
    // OCPPWebSocket methods — `setMessageHandler` (constructor, line ~267),
    // `sendAction` (pumpSerialQueue, line ~665 — unused by this test, no
    // outgoing CP->CSMS call is triggered), and `sendResult`/`sendError`
    // (sendCallResult/sendCallError, lines ~973/~985).
    const fakeSocket = {
      setMessageHandler: (handler: IncomingMessageHandler) => {
        capturedHandler = handler;
      },
      sendAction: () => true,
      sendResult: (messageId: string, payload: unknown) => {
        order.push("sendResult");
        sendResultCalls.push({ messageId, payload });
      },
      sendError: (messageId: string, payload: OcppMessageErrorPayload) => {
        order.push("sendError");
        sendErrorCalls.push({ messageId, payload });
      },
    } as unknown as OCPPWebSocket;

    new OCPPMessageHandler(cp, fakeSocket, logger, codec);

    expect(capturedHandler).not.toBeNull();
    const handler = capturedHandler!;

    cp.events.on("incomingCallReceived", () => order.push("event"));

    // --- (a) ordering + normal-handler dispatch -----------------------
    // No override armed yet: ClearCache falls through to the real
    // ClearCacheHandler, which answers { status: "Accepted" }. handleCall
    // is fire-and-forget from the message-handler callback (`void
    // this.handleCall(...)`), so we poll for the response rather than
    // assume synchronous completion.
    handler(OCPPMessageType.CALL, "msg-1", OCPPAction.ClearCache, {});
    await waitUntil(() => sendResultCalls.length === 1);
    // The incomingCallReceived event is emitted synchronously at the top
    // of handleCall, before any response is sent — assert it lands first.
    expect(order).toEqual(["event", "sendResult"]);
    expect(sendResultCalls[0]).toEqual({
      messageId: "msg-1",
      payload: { status: "Accepted" },
    });

    // --- (b) armed override preempts the normal handler ----------------
    cp.armResponseOverride("ClearCache", "Rejected");
    handler(OCPPMessageType.CALL, "msg-2", OCPPAction.ClearCache, {});
    await waitUntil(() => sendResultCalls.length === 2);
    expect(sendResultCalls[1]).toEqual({
      messageId: "msg-2",
      payload: { status: "Rejected" },
    });

    // --- (c) override was one-shot: third identical CALL falls through --
    handler(OCPPMessageType.CALL, "msg-3", OCPPAction.ClearCache, {});
    await waitUntil(() => sendResultCalls.length === 3);
    expect(sendResultCalls[2]).toEqual({
      messageId: "msg-3",
      payload: { status: "Accepted" },
    });

    expect(sendErrorCalls).toEqual([]);
  });
});
