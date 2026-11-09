import { describe, it, expect, beforeEach, vi } from "vitest";
import { OCPPMessageHandlerV201 } from "../OCPPMessageHandlerV201";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import type { Logger } from "../../../shared/Logger";
import { LogType } from "../../../shared/Logger";
import { OCPPMessageType } from "../../../domain/types/OcppTypes";
import type { Settlement, GenerationToken } from "../network-sim";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { V201InboundRegistry } from "../v201/inboundRegistryV201";

// Fake OCPPWebSocket for testing settlement behavior
class FakeOCPPWebSocket {
  private _generation: number = 0;
  private _currentGen: { gen: number; closeCause: string | null };
  private _connected: boolean = true;
  private _closeTransactionCallback:
    ((finalized: GenerationToken) => void) | null = null;
  pendingSettlements: Array<{
    messageId: string;
    callback?: (s: Settlement) => void;
  }> = [];
  /** Every outbound CALL, in order — the observable for deferred effects. */
  sentCalls: Array<{ action: string; payload: unknown }> = [];

  constructor() {
    this._generation = 1;
    this._currentGen = { gen: this._generation, closeCause: null };
  }

  setMessageHandler(
    handler: (
      type: number,
      id: string,
      action: string,
      payload: unknown,
    ) => void,
  ): void {
    this.messageHandler = handler;
  }

  private messageHandler:
    | ((type: number, id: string, action: string, payload: unknown) => void)
    | null = null;
  /** The id of the latest outbound CALL. */
  lastCallId = "";

  /** The CSMS answers the latest outbound CALL: it frees the one-CALL-in-flight
   *  slot (OCPP-J §4.1.1, #708) for the next. */
  answerLastCall(): void {
    this.messageHandler?.(OCPPMessageType.CALLRESULT, this.lastCallId, "", {});
  }

  onCloseTransaction(cb: (finalized: GenerationToken) => void): void {
    this._closeTransactionCallback = cb;
  }

  currentGeneration(): GenerationToken {
    return this._currentGen as GenerationToken;
  }

  isConnected(): boolean {
    return this._connected;
  }

  sendAction(
    messageId: string,
    action: string,
    payload: unknown,
    _gen: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): boolean {
    this.pendingSettlements.push({ messageId, callback: onSettled });
    this.lastCallId = messageId;
    this.sentCalls.push({ action, payload });
    return true;
  }

  sendResult(
    messageId: string,
    _payload: unknown,
    _gen: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): void {
    // Capture the callback for test-driven settlement
    this.pendingSettlements.push({ messageId, callback: onSettled });
  }

  sendError(
    messageId: string,
    _payload: unknown,
    _gen: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): void {
    // Capture the callback for test-driven settlement
    this.pendingSettlements.push({ messageId, callback: onSettled });
  }

  // Test helpers
  settleCall(
    messageId: string,
    outcome: "written" | "socket_closed" | "disposed" = "written",
  ): void {
    const entry = this.pendingSettlements.find(
      (e) => e.messageId === messageId,
    );
    if (entry?.callback) {
      const settlement: Settlement = { outcome };
      entry.callback(settlement);
    }
  }

  advanceGeneration(): void {
    this._generation++;
    this._currentGen = { gen: this._generation, closeCause: null };
  }

  simulateClose(
    cause: "network" | "manual" | "internal" | "simulated" = "network",
  ): void {
    this._currentGen.closeCause = cause;
    this._connected = false;
    if (this._closeTransactionCallback) {
      this._closeTransactionCallback(this._currentGen as GenerationToken);
    }
  }

  getPendingCount(): number {
    return this.pendingSettlements.length;
  }

  clearPending(): void {
    this.pendingSettlements = [];
  }
}

// Mock ChargePoint
const createMockChargePoint = (): ChargePoint => {
  return {
    notifyOutgoingCall: vi.fn(),
    notifyIncomingCall: vi.fn(),
    notifyIncomingCallCompleted: vi.fn(),
    notifyAuthorizeResult: vi.fn(),
    onBootNotificationResult: vi.fn(),
    cleanTransaction: vi.fn(),
    updateConnectorStatus: vi.fn(),
    getConnector: vi.fn(() => null),
    id: "test-cp",
    configuration: {
      meterValuesSampledData: vi.fn(() => []),
      stopTxnSampledData: vi.fn(() => []),
      stopTxnAlignedData: vi.fn(() => []),
      txStartedMeasurands: vi.fn(() => []),
      getString: vi.fn(),
      // #529: a written TransactionEvent arms its MessageTimeout.
      messageTimeout: vi.fn(() => 30),
      offlineQueueMaxEvents: vi.fn(() => 1000),
    },
    certificateStore: {} as unknown,
    consumeResponseOverride: vi.fn(() => null),
    // #349: the 2.0.1 dispatch consults inbound policies too.
    getInboundCallPolicy: vi.fn(() => undefined),
    hasResponseOverride: vi.fn(() => false),
    clearResponseOverride: vi.fn(),
  } as unknown as ChargePoint;
};

// Mock Logger
const createMockLogger = (): Logger => {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
};

// Mock inbound registry with afterResult handlers
const createRegistryWithEffects = (): V201InboundRegistry => {
  const registry = new Map();

  // GetReport handler with afterResult (sends NotifyReport later)
  registry.set("GetReport", {
    validate: () => true,
    handle: (_payload: unknown, ctx: unknown) => ({
      response: { status: "Accepted" },
      afterResult: () => {
        // Simulate sending a follow-up CALL
        (
          ctx as { sendCall: (action: string, payload: unknown) => void }
        ).sendCall("NotifyReport", { requestId: 123 });
      },
    }),
  });

  // GetVariables handler with afterResult
  registry.set("GetVariables", {
    validate: () => true,
    handle: (_payload: unknown, ctx: unknown) => ({
      response: { status: "Accepted" },
      afterResult: () => {
        // Simulate sending a follow-up CALL
        (
          ctx as { sendCall: (action: string, payload: unknown) => void }
        ).sendCall("NotifyReport", { requestId: 456 });
      },
    }),
  });

  // Heartbeat handler without afterResult
  registry.set("Heartbeat", {
    validate: () => true,
    handle: () => ({
      response: { currentTime: new Date().toISOString() },
    }),
  });

  return registry as V201InboundRegistry;
};

/** Response effects are deferred off the settlement callback, so a settle()
 *  only shows up on the wire after the microtask queue drains. */
async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// Test helper type for accessing private members
type HandlerTestAccess = {
  _pendingRequests: Map<string, unknown>;
  handleIncomingMessage: (...args: unknown[]) => void;
};

describe("OCPPMessageHandlerV201 Settlement", () => {
  let fakeSocket: FakeOCPPWebSocket;
  let mockChargePoint: ChargePoint;
  let mockLogger: Logger;
  let handler: OCPPMessageHandlerV201;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeSocket = new FakeOCPPWebSocket();
    mockChargePoint = createMockChargePoint();
    mockLogger = createMockLogger();
    handler = new OCPPMessageHandlerV201(
      mockChargePoint,
      fakeSocket as unknown as OCPPWebSocket,
      mockLogger,
      createRegistryWithEffects(),
    );
  });

  describe("outbound CALL registration on written settlement", () => {
    it("does NOT register _pendingRequests until settlement outcome is 'written'", () => {
      // Mock the send method
      const spy = vi.spyOn(fakeSocket, "sendAction");

      handler.sendHeartbeat();

      expect(spy).toHaveBeenCalled();
      const [messageId, , , , onSettled] = spy.mock.calls[0];

      // Before settlement: _pendingRequests should be empty
      const pendingBefore = (handler as unknown as HandlerTestAccess)
        ._pendingRequests.size;
      expect(pendingBefore).toBe(0);

      // After written settlement: _pendingRequests should have the entry
      if (onSettled) {
        onSettled({ outcome: "written" });
      }
      const pendingAfter = (handler as unknown as HandlerTestAccess)
        ._pendingRequests.size;
      expect(pendingAfter).toBe(1);
      expect(
        (handler as unknown as HandlerTestAccess)._pendingRequests.has(
          messageId,
        ),
      ).toBe(true);
    });

    it("does NOT register entry on drop outcomes (socket_closed, write_failed, disposed)", () => {
      const spy = vi.spyOn(fakeSocket, "sendAction");

      handler.sendHeartbeat();

      const [messageId, , , , onSettled] = spy.mock.calls[0];

      // Test socket_closed outcome
      if (onSettled) {
        onSettled({ outcome: "socket_closed", closeCause: "network" });
      }
      expect(
        (handler as unknown as HandlerTestAccess)._pendingRequests.has(
          messageId,
        ),
      ).toBe(false);

      // Test with a new call for write_failed
      handler.sendHeartbeat();
      const [messageId2, , , , onSettled2] = spy.mock.calls[1];

      if (onSettled2) {
        onSettled2({ outcome: "write_failed" });
      }
      expect(
        (handler as unknown as HandlerTestAccess)._pendingRequests.has(
          messageId2,
        ),
      ).toBe(false);
    });

    it("calls notifyOutgoingCall only on written settlement", () => {
      const spy = vi.spyOn(fakeSocket, "sendAction");

      handler.sendHeartbeat();

      const [, , , , onSettled] = spy.mock.calls[0];

      // Before settlement: notifyOutgoingCall not called for Heartbeat
      expect(mockChargePoint.notifyOutgoingCall).not.toHaveBeenCalled();

      // On written: should call notifyOutgoingCall with true (Heartbeat)
      if (onSettled) {
        onSettled({ outcome: "written" });
      }
      expect(mockChargePoint.notifyOutgoingCall).toHaveBeenCalledWith(true);

      // On drop: should NOT call notifyOutgoingCall. The next CALL goes
      // after the answer to the first (§4.1.1).
      fakeSocket.answerLastCall();
      vi.mocked(mockChargePoint.notifyOutgoingCall).mockClear();
      handler.sendHeartbeat();
      const [, , , , onSettled2] = spy.mock.calls[1];
      if (onSettled2) {
        onSettled2({ outcome: "socket_closed", closeCause: "network" });
      }
      expect(mockChargePoint.notifyOutgoingCall).not.toHaveBeenCalled();
    });
  });

  describe("drop → never registered", () => {
    it("settlement 'socket_closed' does not register the request, late CALLRESULT hits unknown-id path", () => {
      const spy = vi.spyOn(fakeSocket, "sendAction");

      handler.sendHeartbeat();
      const [messageId, , , , onSettled] = spy.mock.calls[0];

      // Simulate drop
      if (onSettled) {
        onSettled({ outcome: "socket_closed", closeCause: "network" });
      }

      // Request should not be registered
      expect(
        (handler as unknown as HandlerTestAccess)._pendingRequests.has(
          messageId,
        ),
      ).toBe(false);

      // Now simulate a late CALLRESULT arriving
      // This should be handled gracefully (logged as unknown)
      const handleIncoming = (
        handler as unknown as HandlerTestAccess
      ).handleIncomingMessage.bind(handler);
      // No crash expected
      expect(() => {
        handleIncoming(2, messageId, "Heartbeat", {}); // 2 = CALLRESULT
      }).not.toThrow();
    });
  });

  describe("no new timeout for 2.x drops", () => {
    it("advancing fake timers far (e.g. 10min) after a written-but-unanswered CALL does not reject/clean it", () => {
      const spy = vi.spyOn(fakeSocket, "sendAction");

      handler.sendHeartbeat();
      const [messageId, , , , onSettled] = spy.mock.calls[0];

      // Settle as written
      if (onSettled) {
        onSettled({ outcome: "written" });
      }
      expect(
        (handler as unknown as HandlerTestAccess)._pendingRequests.has(
          messageId,
        ),
      ).toBe(true);

      // Advance timers far (10 minutes)
      vi.advanceTimersByTime(10 * 60 * 1000);

      // Entry should still be there (no timeout cleanup)
      expect(
        (handler as unknown as HandlerTestAccess)._pendingRequests.has(
          messageId,
        ),
      ).toBe(true);
    });
  });

  describe("onWebSocketClosed clears written-but-unanswered entries", () => {
    it("handler.onWebSocketClosed() clears _pendingRequests", () => {
      const spy = vi.spyOn(fakeSocket, "sendAction");

      // The second heartbeat waits for the first (§4.1.1, #708).
      handler.sendHeartbeat();
      handler.sendHeartbeat();
      expect(spy.mock.calls).toHaveLength(1);

      const [, , , , cb1] = spy.mock.calls[0];
      if (cb1) {
        cb1({ outcome: "written" });
      }

      expect(
        (handler as unknown as HandlerTestAccess)._pendingRequests.size,
      ).toBe(1);

      // Call onWebSocketClosed
      handler.onWebSocketClosed();

      // Should clear all entries
      expect(
        (handler as unknown as HandlerTestAccess)._pendingRequests.size,
      ).toBe(0);
    });
  });

  describe("afterResult effects at settlement", () => {
    it("inbound CALL with afterResult does not run immediately; runs deferred after 'written' settlement", async () => {
      const handleIncoming = (
        handler as unknown as HandlerTestAccess
      ).handleIncomingMessage.bind(handler);

      // The GetReport handler's afterResult sends NotifyReport{requestId:123},
      // so that CALL appearing on the wire is the effect having run.
      handleIncoming(OCPPMessageType.CALL, "msg-123", "GetReport", {
        requestId: 100,
        componentVariable: [],
      });

      // The CALLRESULT is only accepted, not yet written: the effect must wait.
      expect(fakeSocket.sentCalls).toEqual([]);

      fakeSocket.settleCall("msg-123", "written");
      await flushEffects();

      expect(fakeSocket.sentCalls).toEqual([
        { action: "NotifyReport", payload: { requestId: 123 } },
      ]);
    });

    it("two distinct inbound actions with afterResult (GetReport and GetVariables)", async () => {
      const registry = createRegistryWithEffects();
      const handler2 = new OCPPMessageHandlerV201(
        mockChargePoint,
        fakeSocket as unknown as OCPPWebSocket,
        mockLogger,
        registry,
      );

      const handleIncoming = (
        handler2 as unknown as HandlerTestAccess
      ).handleIncomingMessage.bind(handler2);

      // First: simulate GetReport
      handleIncoming(OCPPMessageType.CALL, "msg-1", "GetReport", {
        requestId: 100,
        componentVariable: [],
      });

      // Second: simulate GetVariables
      handleIncoming(OCPPMessageType.CALL, "msg-2", "GetVariables", {
        attributeType: "Actual",
        variableAttribute: [],
      });

      expect(fakeSocket.sentCalls).toEqual([]);

      fakeSocket.settleCall("msg-1", "written");
      fakeSocket.settleCall("msg-2", "written");
      await flushEffects();

      // One CALL in flight (§4.1.1, #708): the second NotifyReport goes once
      // the first is answered.
      expect(fakeSocket.sentCalls).toEqual([
        { action: "NotifyReport", payload: { requestId: 123 } },
      ]);
      fakeSocket.answerLastCall();

      // Each handler carries its own requestId, so this also proves the two
      // effects didn't get crossed or collapsed into one.
      expect(fakeSocket.sentCalls).toEqual([
        { action: "NotifyReport", payload: { requestId: 123 } },
        { action: "NotifyReport", payload: { requestId: 456 } },
      ]);
    });
  });

  describe("gen threading in sendResult/sendError", () => {
    it("sendResult receives the generation captured at dispatch", () => {
      // Track calls to sendResult
      const sendResultCalls: Array<{
        messageId: string;
        payload: unknown;
        gen: GenerationToken;
        onSettled?: (s: Settlement) => void;
      }> = [];
      const originalSendResult = fakeSocket.sendResult.bind(fakeSocket);
      fakeSocket.sendResult = (
        messageId: string,
        payload: unknown,
        gen: GenerationToken,
        onSettled?: (s: Settlement) => void,
      ) => {
        sendResultCalls.push({ messageId, payload, gen, onSettled });
        originalSendResult(messageId, payload, gen, onSettled);
      };

      const handleIncoming = (
        handler as unknown as HandlerTestAccess
      ).handleIncomingMessage.bind(handler);

      // Simulate incoming Heartbeat (OCPPMessageType.CALL = 2)
      handleIncoming(OCPPMessageType.CALL, "msg-123", "Heartbeat", {});

      // sendResult should have been called with a gen
      expect(sendResultCalls.length).toBeGreaterThan(0);
      const call = sendResultCalls[0];
      expect(call.messageId).toBe("msg-123");
      expect(call.gen).toBeDefined();
      expect((call.gen as GenerationToken).gen).toBe(1);
    });

    it("sendError receives the generation captured at dispatch", () => {
      // Track calls to sendError
      const sendErrorCalls: Array<{
        messageId: string;
        payload: unknown;
        gen: GenerationToken;
        onSettled?: (s: Settlement) => void;
      }> = [];
      const originalSendError = fakeSocket.sendError.bind(fakeSocket);
      fakeSocket.sendError = (
        messageId: string,
        payload: unknown,
        gen: GenerationToken,
        onSettled?: (s: Settlement) => void,
      ) => {
        sendErrorCalls.push({ messageId, payload, gen, onSettled });
        originalSendError(messageId, payload, gen, onSettled);
      };

      const handleIncoming = (
        handler as unknown as HandlerTestAccess
      ).handleIncomingMessage.bind(handler);

      // Simulate incoming unknown action (OCPPMessageType.CALL = 2)
      handleIncoming(OCPPMessageType.CALL, "msg-456", "UnknownAction", {});

      // sendError should have been called with a gen
      expect(sendErrorCalls.length).toBeGreaterThan(0);
      const call = sendErrorCalls[0];
      expect(call.messageId).toBe("msg-456");
      expect(call.gen).toBeDefined();
      expect((call.gen as GenerationToken).gen).toBe(1);
    });
  });

  describe("send-false preservation", () => {
    it("socket.sendAction returning false logs debug message", () => {
      // Mock sendAction to return false
      vi.spyOn(fakeSocket, "sendAction").mockReturnValue(false);

      handler.sendHeartbeat();

      // Should have logged a debug message
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("sendAction returned false"),
        LogType.WEBSOCKET,
      );
    });
  });

  describe("single-callback onCloseTransaction", () => {
    it("handler registers ONE callback via onCloseTransaction; later calls overwrite", () => {
      const spy = vi.spyOn(fakeSocket, "onCloseTransaction");

      // Create handler (in constructor, it registers callback)
      new OCPPMessageHandlerV201(
        mockChargePoint,
        fakeSocket as unknown as OCPPWebSocket,
        mockLogger,
        createRegistryWithEffects(),
      );

      // onCloseTransaction should have been called once
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(expect.any(Function));

      // If another handler were created on same socket, its callback would overwrite
      // (but per design, one protocol per connection, so this is fine)
    });
  });

  describe("ChargePoint construction validation", () => {
    it("handler is constructed with correct ChargePoint per connection (v201 handler)", () => {
      // This is a design check: only ONE handler per socket connection
      // The test verifies the handler is wired to the ChargePoint correctly

      const spyNotify = vi.spyOn(mockChargePoint, "notifyOutgoingCall");

      // Send a Heartbeat, which should notify
      const sendSpy = vi.spyOn(fakeSocket, "sendAction");
      handler.sendHeartbeat();

      const [, , , , onSettled] = sendSpy.mock.calls[0];
      if (onSettled) {
        onSettled({ outcome: "written" });
      }

      // notifyOutgoingCall should be called with true (Heartbeat)
      expect(spyNotify).toHaveBeenCalledWith(true);
    });
  });
});
