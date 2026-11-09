import { describe, expect, it, vi } from "vitest";
import { OCPPMessageHandler } from "../OCPPMessageHandler";
import { OCPPMessageType } from "../../../domain/types/OcppTypes";
import { Logger, LogLevel } from "../../../shared/Logger";
import type { ProtocolCodec } from "../profile/ProtocolProfile";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { GenerationToken, Settlement } from "../network-sim";

/**
 * The 1.6 handler answers an inbound CALL through the shared CallExchange and
 * InboundCallGate. This pins what the exchange adds to the old flow: an answer
 * is written in the turn the handler produced it, an answer on a connection
 * that changed is not sent and is announced as unanswered, and a disconnect
 * abandons the CALLs still waiting.
 */
class Socket {
  gen: GenerationToken = { gen: 1, closeCause: null };
  wire: Array<{ kind: "result" | "error"; id: string; payload: unknown }> = [];
  hooks = new Map<string, (s: Settlement) => void>();
  private handler:
    | ((type: number, id: string, action: string, payload: unknown) => void)
    | undefined;
  private onClose: ((finalized: GenerationToken) => void) | undefined;

  setMessageHandler(handler: Socket["handler"]): void {
    this.handler = handler;
  }
  onCloseTransaction(callback: (finalized: GenerationToken) => void): void {
    this.onClose = callback;
  }
  currentGeneration(): GenerationToken {
    return this.gen;
  }
  isConnected(): boolean {
    return true;
  }
  sendResult(
    id: string,
    payload: unknown,
    _gen: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): void {
    this.wire.push({ kind: "result", id, payload });
    if (onSettled) this.hooks.set(id, onSettled);
  }
  sendError(id: string, payload: unknown): void {
    this.wire.push({ kind: "error", id, payload });
  }
  deliver(id: string, action: string, payload: unknown): void {
    this.handler?.(OCPPMessageType.CALL, id, action, payload);
  }
  reconnect(): void {
    this.gen = { gen: this.gen.gen + 1, closeCause: null };
  }
  close(): void {
    this.onClose?.(this.gen);
  }
}

function setup() {
  const socket = new Socket();
  const completions: unknown[] = [];
  const chargePoint = {
    id: "cp-ex",
    configuration: {
      transactionMessageAttempts: () => 3,
      meterValuesSampledData: () => [],
      stopTxnSampledData: () => [],
      stopTxnAlignedData: () => [],
      txStartedMeasurands: () => [],
    },
    notifyIncomingCall: vi.fn(),
    notifyIncomingCallCompleted: (c: unknown) => completions.push(c),
    notifyOutgoingCall: vi.fn(),
    getInboundCallPolicy: vi.fn(() => undefined),
    consumeResponseOverride: vi.fn(() => null),
  } as unknown as ChargePoint;
  const handler = new OCPPMessageHandler(
    chargePoint,
    socket as unknown as OCPPWebSocket,
    new Logger(LogLevel.ERROR),
    { outgoingWarning: () => null } as unknown as ProtocolCodec,
  );
  return { socket, completions, chargePoint, handler };
}

/** Make `action` answer with whatever the test releases, asynchronously. */
function holdAnswer(handler: OCPPMessageHandler, action: string) {
  let release!: (payload: unknown) => void;
  const registry = (
    handler as unknown as {
      _registry: { getCallHandler: (a: string) => unknown };
    }
  )._registry;
  const original = registry.getCallHandler.bind(registry);
  registry.getCallHandler = (a: string) =>
    a === action
      ? {
          handle: () =>
            new Promise((resolve) => {
              release = resolve;
            }),
        }
      : original(a);
  return (payload: unknown) => release(payload);
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("OCPPMessageHandler answers through the CallExchange", () => {
  it("answers an unsupported action with NotImplemented, once", async () => {
    const { socket, completions } = setup();
    socket.deliver("m-1", "NoSuchAction", {});
    await flush();
    expect(socket.wire).toHaveLength(1);
    expect(socket.wire[0]).toMatchObject({
      kind: "error",
      id: "m-1",
      payload: { errorCode: "NotImplemented" },
    });
    expect(completions).toEqual([
      {
        action: "NoSuchAction",
        messageId: "m-1",
        outcome: "CallError",
        errorCode: "NotImplemented",
      },
    ]);
  });

  it("writes an async handler's CALLRESULT under the CALL's id and announces it once", async () => {
    const { socket, completions, handler } = setup();
    const release = holdAnswer(handler, "ClearCache");
    socket.deliver("m-2", "ClearCache", {});
    expect(socket.wire).toEqual([]);
    release({ status: "Accepted" });
    await flush();
    expect(socket.wire).toEqual([
      { kind: "result", id: "m-2", payload: { status: "Accepted" } },
    ]);
    expect(completions).toEqual([
      { action: "ClearCache", messageId: "m-2", outcome: "CallResult" },
    ]);
    // no effect, so the transport got no settlement hook
    expect(socket.hooks.has("m-2")).toBe(false);
  });

  it("does not send an answer that arrives after a reconnect, and announces the CALL as unanswered", async () => {
    const { socket, completions, handler } = setup();
    const release = holdAnswer(handler, "ClearCache");
    socket.deliver("m-3", "ClearCache", {});
    socket.reconnect();
    release({ status: "Accepted" });
    await flush();
    expect(socket.wire).toEqual([]);
    expect(completions).toEqual([
      { action: "ClearCache", messageId: "m-3", outcome: "NoResponse" },
    ]);
  });

  it("a disconnect abandons a CALL still waiting: announced at once, a late answer is not sent", async () => {
    const { socket, completions, handler } = setup();
    const release = holdAnswer(handler, "ClearCache");
    socket.deliver("m-4", "ClearCache", {});
    socket.close();
    expect(completions).toEqual([
      { action: "ClearCache", messageId: "m-4", outcome: "NoResponse" },
    ]);
    release({ status: "Accepted" });
    await flush();
    expect(socket.wire).toEqual([]);
    expect(completions).toHaveLength(1);
  });

  it("a failing handler gets InternalError, once", async () => {
    const { socket, handler } = setup();
    const registry = (
      handler as unknown as {
        _registry: { getCallHandler: (a: string) => unknown };
      }
    )._registry;
    registry.getCallHandler = () => ({
      handle: () => Promise.reject(new Error("boom")),
    });
    socket.deliver("m-5", "ClearCache", {});
    await flush();
    expect(socket.wire).toHaveLength(1);
    expect(socket.wire[0]).toMatchObject({
      kind: "error",
      payload: { errorCode: "InternalError", errorDescription: "Error: boom" },
    });
  });
});
