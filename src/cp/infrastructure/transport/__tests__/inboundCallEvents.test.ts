import { describe, expect, it, vi } from "vitest";

import { OCPPMessageHandler } from "../OCPPMessageHandler";
import type { OCPPWebSocket, OcppMessageErrorPayload } from "../OCPPWebSocket";
import type { ProtocolCodec } from "../profile/ProtocolProfile";
import { outgoingV16Warning } from "../codec/validateV16";
import {
  ChargePoint,
  type StartTransactionOutcome,
} from "../../../domain/charge-point/ChargePoint";
import {
  DefaultBootNotification,
  OCPPAction,
  OCPPMessageType,
} from "../../../domain/types/OcppTypes";
import { Logger, LogLevel } from "../../../shared/Logger";

/**
 * #396: every inbound CSMS CALL is announced as it enters dispatch
 * (incomingCallReceived, now carrying the messageId) and again once the
 * answer is decided (incomingCallCompleted), just before that answer is
 * handed to the transport. The answer itself is unchanged.
 */

type IncomingMessageHandler = (
  messageType: OCPPMessageType,
  messageId: string,
  action: OCPPAction,
  payload: unknown,
) => void;

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

function harness(id: string) {
  const cp = newChargePoint(id);
  const order: string[] = [];
  const results: Array<{ messageId: string; payload: unknown }> = [];
  const errors: Array<{ messageId: string; payload: OcppMessageErrorPayload }> =
    [];
  let captured: IncomingMessageHandler | null = null;
  const fakeSocket = {
    setMessageHandler: (handler: IncomingMessageHandler) => {
      captured = handler;
    },
    sendAction: () => true,
    sendResult: (
      messageId: string,
      payload: unknown,
      _gen: unknown,
      onSettled?: (s: { outcome: "written" }) => void,
    ) => {
      order.push(`sendResult:${messageId}`);
      results.push({ messageId, payload });
      onSettled?.({ outcome: "written" });
    },
    sendError: (messageId: string, payload: OcppMessageErrorPayload) => {
      order.push(`sendError:${messageId}`);
      errors.push({ messageId, payload });
    },
    currentGeneration: () => ({ gen: 1, closeCause: null }),
  } as unknown as OCPPWebSocket;
  const codec: ProtocolCodec = { outgoingWarning: outgoingV16Warning };
  new OCPPMessageHandler(cp, fakeSocket, new Logger(LogLevel.ERROR), codec);

  const received: unknown[] = [];
  const completed: unknown[] = [];
  cp.events.on("incomingCallReceived", (data) => {
    order.push(`received:${data.messageId}`);
    received.push(data);
  });
  cp.events.on("incomingCallCompleted", (data) => {
    order.push(`completed:${data.messageId}`);
    completed.push(data);
  });
  const call = (messageId: string, action: OCPPAction, payload: unknown) =>
    captured!(OCPPMessageType.CALL, messageId, action, payload);
  return { cp, order, results, errors, received, completed, call };
}

describe("inbound CSMS CALL events on OCPP 1.6J (#396)", () => {
  it("announces a Reset before dispatch and its CallResult before the reboot", async () => {
    const h = harness("CP-396-RESET");
    const reset = vi.spyOn(h.cp, "applyRemoteReset").mockImplementation(() => {
      h.order.push("reset");
    });

    h.call("r-1", OCPPAction.Reset, { type: "Soft" });
    await waitUntil(() => reset.mock.calls.length === 1);

    expect(h.order).toEqual([
      "received:r-1",
      "completed:r-1",
      "sendResult:r-1",
      "reset",
    ]);
    expect(h.received).toEqual([
      { action: "Reset", messageId: "r-1", payload: { type: "Soft" } },
    ]);
    expect(h.completed).toEqual([
      { action: "Reset", messageId: "r-1", outcome: "CallResult" },
    ]);
    expect(h.results).toEqual([
      { messageId: "r-1", payload: { status: "Accepted" } },
    ]);
  });

  it("completes a RemoteStartTransaction after the handler started the transaction", async () => {
    const h = harness("CP-396-REMOTE-START");
    vi.spyOn(h.cp, "startTransaction").mockImplementation(() => {
      h.order.push("startTransaction");
      return Promise.resolve<StartTransactionOutcome>({ started: true });
    });

    h.call("s-1", OCPPAction.RemoteStartTransaction, {
      idTag: "TAG-1",
      connectorId: 1,
    });
    await waitUntil(() => h.results.length === 1);

    expect(h.order).toEqual([
      "received:s-1",
      "startTransaction",
      "completed:s-1",
      "sendResult:s-1",
    ]);
    expect(h.completed).toEqual([
      {
        action: "RemoteStartTransaction",
        messageId: "s-1",
        outcome: "CallResult",
      },
    ]);
    expect(h.results[0].payload).toEqual({ status: "Accepted" });
  });

  it("correlates repeated calls of the same action by messageId", async () => {
    const h = harness("CP-396-REPEAT");
    h.call("c-1", OCPPAction.ClearCache, {});
    h.call("c-2", OCPPAction.ClearCache, {});
    await waitUntil(() => h.results.length === 2);

    expect(h.completed).toEqual([
      { action: "ClearCache", messageId: "c-1", outcome: "CallResult" },
      { action: "ClearCache", messageId: "c-2", outcome: "CallResult" },
    ]);
  });

  it("reports a CallError with its code when the action is not implemented", async () => {
    const h = harness("CP-396-UNKNOWN");
    h.call("u-1", "NoSuchAction" as OCPPAction, {});
    await waitUntil(() => h.errors.length === 1);

    expect(h.order).toEqual(["received:u-1", "completed:u-1", "sendError:u-1"]);
    expect(h.completed).toEqual([
      {
        action: "NoSuchAction",
        messageId: "u-1",
        outcome: "CallError",
        errorCode: "NotImplemented",
      },
    ]);
    expect(h.errors[0].payload.errorCode).toBe("NotImplemented");
  });

  it("reports InternalError when the handler throws", async () => {
    const h = harness("CP-396-THROW");
    vi.spyOn(h.cp, "applyRemoteReset").mockImplementation(() => undefined);
    // A null payload makes the Reset handler read `payload.type` of null.
    h.call("t-1", OCPPAction.Reset, null);
    await waitUntil(() => h.errors.length === 1);

    expect(h.completed).toEqual([
      {
        action: "Reset",
        messageId: "t-1",
        outcome: "CallError",
        errorCode: "InternalError",
      },
    ]);
  });

  it("reports the answer an inbound policy or a response override chose", async () => {
    const h = harness("CP-396-POLICY");
    h.cp.setInboundCallPolicy("ClearCache", {
      kind: "callerror",
      errorCode: "GenericError",
      errorDescription: "nope",
    });
    h.call("p-1", OCPPAction.ClearCache, {});
    await waitUntil(() => h.errors.length === 1);

    h.cp.setInboundCallPolicy("ClearCache", { kind: "ignore" });
    h.call("p-2", OCPPAction.ClearCache, {});
    await waitUntil(() => h.completed.length === 2);

    h.cp.clearInboundCallPolicy("ClearCache");
    h.cp.armResponseOverride("ClearCache", "Rejected");
    h.call("p-3", OCPPAction.ClearCache, {});
    await waitUntil(() => h.results.length === 1);

    expect(h.completed).toEqual([
      {
        action: "ClearCache",
        messageId: "p-1",
        outcome: "CallError",
        errorCode: "GenericError",
      },
      { action: "ClearCache", messageId: "p-2", outcome: "NoResponse" },
      { action: "ClearCache", messageId: "p-3", outcome: "CallResult" },
    ]);
    expect(h.results).toEqual([
      { messageId: "p-3", payload: { status: "Rejected" } },
    ]);
  });
});
