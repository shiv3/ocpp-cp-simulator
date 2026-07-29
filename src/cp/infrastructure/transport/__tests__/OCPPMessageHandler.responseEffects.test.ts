import { describe, it, expect, beforeEach, vi } from "vitest";
import { OCPPMessageHandler } from "../OCPPMessageHandler";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { Logger } from "../../../shared/Logger";
import type { ProtocolCodec } from "../profile/ProtocolProfile";
import type {
  HandlerOutcome,
  Settlement,
  GenerationToken,
} from "../network-sim";
import { OCPPAction, OCPPMessageType } from "../../../domain/types/OcppTypes";

// Mock ChargePoint and minimal dependencies
const mockChargePoint = {
  id: "test-cp",
  database: null,
  notifyIncomingCall: vi.fn(),
  consumeResponseOverride: vi.fn(() => null),
  getInboundCallPolicy: vi.fn(() => undefined),
  configuration: {
    getString: vi.fn(() => "TestCPO"),
    transactionMessageAttempts: vi.fn(() => 5),
  },
} as unknown as ChargePoint;

// Mock Logger
const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

// Mock ProtocolCodec
const mockCodec = {} as ProtocolCodec;

// Mock OCPPWebSocket with the necessary methods for this test
class MockOCPPWebSocket implements Partial<OCPPWebSocket> {
  private closeTransactionCallback:
    ((finalized: GenerationToken) => void) | null = null;
  private generationCounter = 1;
  private currentGenToken: { gen: number; closeCause: null | string } = {
    gen: 1,
    closeCause: null,
  };
  // Capture onSettled callbacks for manual testing
  capturedCallbacks: Array<{
    messageId: string;
    gen?: GenerationToken;
    onSettled?: (s: Settlement) => void;
  }> = [];

  setMessageHandler(): void {
    // No-op for test
  }

  onCloseTransaction(cb: (finalized: GenerationToken) => void): void {
    this.closeTransactionCallback = cb;
  }

  currentGeneration(): ReturnType<OCPPWebSocket["currentGeneration"]> {
    return this.currentGenToken as unknown as GenerationToken;
  }

  sendResult(
    messageId: string,
    _payload: unknown,
    gen?: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): void {
    // Capture the callback for test-driven settlement
    this.capturedCallbacks.push({ messageId, gen, onSettled });
  }

  sendError(
    messageId: string,
    _payload: unknown,
    gen?: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): void {
    // Capture the callback for test-driven settlement
    this.capturedCallbacks.push({ messageId, gen, onSettled });
  }

  // Trigger close for testing close transaction behavior
  simulateClose(closeCause: string = "network"): void {
    if (this.closeTransactionCallback) {
      this.currentGenToken.closeCause = closeCause;
      this.closeTransactionCallback(
        this.currentGenToken as unknown as GenerationToken,
      );
    }
  }

  // Advance generation for stale response test
  advanceGeneration(): void {
    this.generationCounter++;
    this.currentGenToken = { gen: this.generationCounter, closeCause: null };
  }

  /** Settle the response the handler sent for `messageId`, exactly as the
   *  transport pipeline would. Fails loudly if nothing was ever sent — the
   *  effect wiring is only under test if a real response went out. */
  settleCallback(messageId: string, settlement: Settlement): void {
    const entry = this.capturedCallbacks.find((c) => c.messageId === messageId);
    if (!entry) throw new Error(`no response was sent for ${messageId}`);
    entry.onSettled?.(settlement);
  }

  settlementHookFor(messageId: string): ((s: Settlement) => void) | undefined {
    return this.capturedCallbacks.find((c) => c.messageId === messageId)
      ?.onSettled;
  }
}

/** The queue defers effects with queueMicrotask; drain that before asserting. */
async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

type HandlerTestAccess = {
  _registry: {
    registerCallHandler: (action: OCPPAction, handler: unknown) => void;
  };
  handleIncomingMessage: (
    type: number,
    messageId: string,
    action: string,
    payload: unknown,
  ) => Promise<void> | void;
};

/** Replace DataTransfer's handler with one returning `result`, so an inbound
 *  CALL exercises the production normalize → register → sendResult path. */
function installHandler(handler: OCPPMessageHandler, result: unknown): void {
  (handler as unknown as HandlerTestAccess)._registry.registerCallHandler(
    OCPPAction.DataTransfer,
    { handle: () => result },
  );
}

async function deliverDataTransfer(
  handler: OCPPMessageHandler,
  messageId: string,
): Promise<void> {
  await (handler as unknown as HandlerTestAccess).handleIncomingMessage(
    OCPPMessageType.CALL,
    messageId,
    OCPPAction.DataTransfer,
    { vendorId: "test" },
  );
}

describe("OCPPMessageHandler.responseEffects", () => {
  let mockWebSocket: MockOCPPWebSocket;
  let handler: OCPPMessageHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWebSocket = new MockOCPPWebSocket();
    handler = new OCPPMessageHandler(
      mockChargePoint,
      mockWebSocket as unknown as OCPPWebSocket,
      mockLogger,
      mockCodec,
    );
  });

  it("defers a HandlerOutcome effect until settlement, then runs it once", async () => {
    const effectFn = vi.fn();
    const outcome: HandlerOutcome = {
      kind: "handler-outcome",
      payload: { status: "Accepted" },
      afterResponseSettled: effectFn,
    };
    installHandler(handler, outcome);

    await deliverDataTransfer(handler, "msg-1");

    // The CALLRESULT has been handed to the transport but not yet written:
    // running the effect now would act on a response that may never land.
    expect(effectFn).not.toHaveBeenCalled();

    mockWebSocket.settleCallback("msg-1", { outcome: "written" });
    expect(effectFn).not.toHaveBeenCalled(); // deferred, not synchronous
    await flushEffects();

    expect(effectFn).toHaveBeenCalledTimes(1);
  });

  it("drops the effect when the generation was superseded before it ran", async () => {
    const effectFn = vi.fn();
    installHandler(handler, {
      kind: "handler-outcome",
      payload: { status: "Accepted" },
      afterResponseSettled: effectFn,
    } satisfies HandlerOutcome);

    await deliverDataTransfer(handler, "msg-stale");

    // Reconnect between send and settlement: the response belongs to a dead
    // socket, so its follow-up must not fire on the new one.
    mockWebSocket.advanceGeneration();
    mockWebSocket.settleCallback("msg-stale", { outcome: "written" });
    await flushEffects();

    expect(effectFn).not.toHaveBeenCalled();
  });

  it("holds a socket_closed effect and runs it when the close was a network drop", async () => {
    const effectFn = vi.fn();
    installHandler(handler, {
      kind: "handler-outcome",
      payload: { status: "Accepted" },
      afterResponseSettled: effectFn,
    } satisfies HandlerOutcome);

    await deliverDataTransfer(handler, "msg-netclose");

    mockWebSocket.settleCallback("msg-netclose", { outcome: "socket_closed" });
    await flushEffects();
    // Held: the close transaction has not finalized, so the cause is unknown.
    expect(effectFn).not.toHaveBeenCalled();

    mockWebSocket.simulateClose("network");
    await flushEffects();

    expect(effectFn).toHaveBeenCalledTimes(1);
  });

  it("drops a held effect when the operator disconnected manually", async () => {
    const effectFn = vi.fn();
    installHandler(handler, {
      kind: "handler-outcome",
      payload: { status: "Accepted" },
      afterResponseSettled: effectFn,
    } satisfies HandlerOutcome);

    await deliverDataTransfer(handler, "msg-manualclose");

    mockWebSocket.settleCallback("msg-manualclose", {
      outcome: "socket_closed",
    });
    mockWebSocket.simulateClose("manual");
    await flushEffects();

    expect(effectFn).not.toHaveBeenCalled();
  });

  it("registers no settlement hook for a bare-payload handler", async () => {
    installHandler(handler, { status: "Accepted" });

    await deliverDataTransfer(handler, "msg-bare");

    // No effect to run means nothing should be subscribed to the settlement,
    // keeping the pre-existing handlers on their original code path.
    expect(mockWebSocket.settlementHookFor("msg-bare")).toBeUndefined();
  });
});
