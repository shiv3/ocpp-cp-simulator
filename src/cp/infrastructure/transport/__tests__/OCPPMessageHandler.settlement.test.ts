import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { OCPPMessageHandler } from "../OCPPMessageHandler";
import { OCPPStatus } from "../../../domain/types/OcppTypes";
import { Logger, LogLevel } from "../../../shared/Logger";
import type { ProtocolCodec } from "../profile/ProtocolProfile";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { Settlement } from "../network-sim";
import type { GenerationToken } from "../network-sim";
import { MetricsRecorder } from "../../../../cli/server/metrics/MetricsRecorder";

/**
 * Controllable fake OCPPWebSocket for testing settlement-based serializer custody.
 * Allows tests to drive settlement timing and verify the slot phases.
 */
class FakeSocket implements Partial<OCPPWebSocket> {
  private _generation = 0;
  private _currentGen: GenerationToken = { gen: 0, closeCause: null };
  private _connected = true;
  public pendingSettlements: Array<{
    id: string;
    onSettled: (s: Settlement) => void;
  }> = [];

  setMessageHandler(_handler: unknown): void {
    // No-op for this test
  }

  currentGeneration(): GenerationToken {
    return this._currentGen;
  }

  isConnected(): boolean {
    return this._connected;
  }

  disconnect(): void {
    this._connected = false;
  }

  reconnect(): void {
    this._connected = true;
    this._generation++;
    this._currentGen = { gen: this._generation, closeCause: null };
  }

  sendAction(
    messageId: string,
    _action: string,
    _payload: unknown,
    gen?: GenerationToken,
    onSettled?: (s: Settlement) => void,
  ): boolean {
    const token = gen ?? this._currentGen;

    // Stale generation check
    if (token.gen !== this._currentGen.gen) {
      return false;
    }

    // Socket-open gate
    if (!this.isConnected()) {
      return false;
    }

    if (onSettled) {
      this.pendingSettlements.push({ id: messageId, onSettled });
    }

    return true;
  }

  // Test helper: manually settle a pending CALL
  settleCall(id: string, settlement: Settlement): void {
    const idx = this.pendingSettlements.findIndex((p) => p.id === id);
    if (idx !== -1) {
      const { onSettled } = this.pendingSettlements[idx];
      this.pendingSettlements.splice(idx, 1);
      onSettled(settlement);
    }
  }

  // Test helper: settle immediately (synchronous)
  settleSynchronously(id: string, settlement: Settlement): void {
    // Trigger settlement inline
    const pending = this.pendingSettlements.find((p) => p.id === id);
    if (pending) {
      pending.onSettled(settlement);
      this.pendingSettlements = this.pendingSettlements.filter(
        (p) => p.id !== id,
      );
    }
  }

  // Test helper: get pending settlement count
  getPendingCount(): number {
    return this.pendingSettlements.length;
  }

  // Test helper: settle all pending (for cleanup)
  settleAllPending(): void {
    for (const { onSettled } of this.pendingSettlements) {
      onSettled({ outcome: "written" });
    }
    this.pendingSettlements = [];
  }
}

/**
 * Mock ChargePoint with just enough behavior for the serializer tests.
 */
class MockChargePoint {
  id = "TEST-CP";
  database: unknown = null;

  configuration = {
    transactionMessageAttempts: () => 3,
    meterValuesSampledData: () => ["Energy.Active.Import.Register"],
  };

  notifyOutgoingCall(_isHeartbeat: boolean): void {
    // No-op for this test
  }

  notifyIncomingCall(_action: string, _payload: unknown): void {
    // No-op for this test
  }

  consumeResponseOverride(_action: string): string | null {
    return null;
  }

  getConnector(_connectorId: number): unknown {
    return { id: _connectorId };
  }

  cleanTransaction(_connectorId: number): void {
    // No-op for this test
  }

  updateConnectorStatus(_connectorId: number, _status: unknown): void {
    // No-op for this test
  }

  notifyAuthorizeResult(_idTag: string, _status: string): void {
    // No-op for this test
  }
}

/**
 * Mock ProtocolCodec for outgoing warnings.
 */
class MockCodec implements Partial<ProtocolCodec> {
  outgoingWarning(_action: string, _payload: unknown): string | null {
    return null;
  }
}

describe("OCPPMessageHandler settlement-based serializer custody", () => {
  let fakeSocket: FakeSocket;
  let mockChargePoint: MockChargePoint;
  let logger: Logger;
  let codec: MockCodec;
  let handler: OCPPMessageHandler;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeSocket = new FakeSocket();
    mockChargePoint = new MockChargePoint();
    logger = new Logger(LogLevel.DEBUG);
    codec = new MockCodec();

    handler = new OCPPMessageHandler(
      mockChargePoint as unknown as ChargePoint,
      fakeSocket as unknown as OCPPWebSocket,
      logger,
      codec as unknown as ProtocolCodec,
    );

    // Open the boot gate for most tests (except where we're testing the boot gate itself)
    handler.setBootStatus({ status: "Accepted" });
    vi.runAllTimersAsync();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe("disabled (synchronous 'written') path", () => {
    it("arms timeout after settlement fires 'written', preserving response wait behavior", () => {
      handler.sendHeartbeat();

      // At this point, the slot is "queued" and sendAction is pending settlement
      expect(fakeSocket.getPendingCount()).toBe(1);
      const heartbeatId = fakeSocket.pendingSettlements[0].id;

      // Settle as written synchronously
      fakeSocket.settleSynchronously(heartbeatId, { outcome: "written" });

      // The timeout should now be armed (30s). Advance time to verify it fires.
      vi.advanceTimersByTime(30_000 + 1);

      // The timeout should have fired; the slot should be cleared
      // We verify this by sending another CALL which should now go to wire
      let secondSendActionCalled = false;
      const origSendAction = fakeSocket.sendAction.bind(fakeSocket);
      fakeSocket.sendAction = (id, action, payload, gen, onSettled) => {
        if (action === "StatusNotification") {
          secondSendActionCalled = true;
        }
        return origSendAction(id, action, payload, gen, onSettled);
      };

      handler.sendStatusNotification(0, OCPPStatus.Available);

      // The second CALL should now go to wire (slot was cleared by timeout)
      expect(secondSendActionCalled).toBe(true);
    });

    it("emits the watchdog line the daemon's timeout counter is parsed from (#302)", () => {
      // The daemon counts abandoned CALLs off this exact log line, because the
      // transport also runs in the browser and must not import a Prometheus
      // recorder. That makes the wording load-bearing: drive the real watchdog
      // and assert the emitted line still reaches the counter.
      const recorder = new MetricsRecorder();
      const unsubscribe = recorder.attach({
        cpId: "TEST-CP",
        ocppVersion: "OCPP-1.6J",
        logger,
      });
      try {
        handler.sendHeartbeat();
        const heartbeatId = fakeSocket.pendingSettlements[0].id;
        fakeSocket.settleSynchronously(heartbeatId, { outcome: "written" });

        expect(recorder.callTimeouts.size).toBe(0);
        vi.advanceTimersByTime(30_000 + 1);
        expect(recorder.callTimeouts.get("Heartbeat")).toBe(1);
      } finally {
        unsubscribe();
      }
    });
  });

  describe("slot held while queued", () => {
    it("holds the serializer slot in queued phase until settlement fires 'written'", () => {
      handler.sendHeartbeat();

      // At this point, the slot is "queued" and sendAction is pending settlement
      expect(fakeSocket.getPendingCount()).toBe(1);

      // Send another CALL — should NOT go to wire because slot is occupied
      const origSendAction = fakeSocket.sendAction.bind(fakeSocket);
      let secondSendActionCalled = false;
      fakeSocket.sendAction = (id, action, payload, gen, onSettled) => {
        if (action === "StatusNotification") {
          secondSendActionCalled = true;
        }
        return origSendAction(id, action, payload, gen, onSettled);
      };

      handler.sendStatusNotification(0, OCPPStatus.Available);

      // The second CALL should NOT trigger a second sendAction call
      expect(secondSendActionCalled).toBe(false);

      // Both CALLs should be tracked: one in-flight, one queued
      expect(fakeSocket.getPendingCount()).toBe(1);
    });

    it("transitions from queued to written on settlement, then arms timeout", () => {
      handler.sendHeartbeat();
      const heartbeatId = fakeSocket.pendingSettlements[0].id;

      // Settle as written
      fakeSocket.settleSynchronously(heartbeatId, { outcome: "written" });

      // The timeout should now be armed; advance time to verify it fires
      vi.advanceTimersByTime(30_000 + 1);

      // The timeout should have fired; the slot should be cleared
      // (we can't directly inspect the slot, but we can send another CALL)
      let thirdSendActionCalled = false;
      const origSendAction = fakeSocket.sendAction.bind(fakeSocket);
      fakeSocket.sendAction = (id, action, payload, gen, onSettled) => {
        if (action === "StatusNotification") {
          thirdSendActionCalled = true;
        }
        return origSendAction(id, action, payload, gen, onSettled);
      };

      handler.sendStatusNotification(0, OCPPStatus.Available);

      // Now the second CALL should go to wire
      expect(thirdSendActionCalled).toBe(true);
    });
  });

  describe("120s delay vs 30s timeout", () => {
    it("starts the 30s timeout only when settlement fires 'written', not at enqueue", () => {
      handler.sendHeartbeat();
      const heartbeatId = fakeSocket.pendingSettlements[0].id;

      // Simulate a delayed write: queue for 120s, then settle
      vi.advanceTimersByTime(120_000);

      // At 120s, the frame still hasn't been written; timeout should not have fired yet
      fakeSocket.settleSynchronously(heartbeatId, { outcome: "written" });

      // Advance another 20s (total 140s elapsed)
      vi.advanceTimersByTime(20_000);

      // The slot should still be occupied because the 30s window just started at t≈120s
      let statusNotificationSent = false;
      const origSendAction = fakeSocket.sendAction.bind(fakeSocket);
      fakeSocket.sendAction = (id, action, payload, gen, onSettled) => {
        if (action === "StatusNotification") {
          statusNotificationSent = true;
        }
        return origSendAction(id, action, payload, gen, onSettled);
      };

      handler.sendStatusNotification(0, OCPPStatus.Available);
      expect(statusNotificationSent).toBe(false);

      // Advance to t≈150s (30s after write settled)
      vi.advanceTimersByTime(10_000 + 1);

      // Now the timeout fires and the slot clears
      handler.sendStatusNotification(0, OCPPStatus.Available);
      expect(statusNotificationSent).toBe(true);
    });
  });

  describe("boot gate interaction", () => {
    it("without boot gate, CALLs are blocked until Accepted", () => {
      // Create a fresh handler without opening the boot gate
      const freshHandler = new OCPPMessageHandler(
        mockChargePoint as unknown as ChargePoint,
        fakeSocket as unknown as OCPPWebSocket,
        logger,
        codec as unknown as ProtocolCodec,
      );

      // Try to send a Heartbeat (should NOT go to wire because boot gate is closed)
      freshHandler.sendHeartbeat();

      // Should be no pending settlements because the CALL was suppressed by the boot gate
      expect(fakeSocket.getPendingCount()).toBe(0);

      // Now open the boot gate
      freshHandler.setBootStatus({ status: "Accepted" });
      vi.runAllTimersAsync();

      // Send Heartbeat again
      freshHandler.sendHeartbeat();

      // Now it should go to wire
      expect(fakeSocket.getPendingCount()).toBe(1);
    });
  });

  describe("drop pump rules", () => {
    it("socket_closed settlement does NOT pump, just clears the slot", () => {
      handler.sendHeartbeat();
      const heartbeatId = fakeSocket.pendingSettlements[0].id;

      // Send a StatusNotification queued behind the Heartbeat
      handler.sendStatusNotification(0, OCPPStatus.Available);

      // Settle Heartbeat as socket_closed (NOT "written")
      fakeSocket.settleSynchronously(heartbeatId, {
        outcome: "socket_closed",
        closeCause: "network",
      });

      // StatusNotification should still be queued and NOT sent (pump did not run)
      expect(fakeSocket.getPendingCount()).toBe(0);
    });

    it("write_failed settlement does NOT pump if socket is disconnected", () => {
      handler.sendHeartbeat();
      const heartbeatId = fakeSocket.pendingSettlements[0].id;

      handler.sendStatusNotification(0, OCPPStatus.Available);

      // Disconnect the socket
      fakeSocket.disconnect();

      // Settle Heartbeat as write_failed
      fakeSocket.settleSynchronously(heartbeatId, { outcome: "write_failed" });

      // Run microtasks
      vi.runAllTimersAsync();

      // StatusNotification should still be queued and not sent
      expect(fakeSocket.getPendingCount()).toBe(0);
    });
  });

  describe("onWebSocketClosed behavior", () => {
    it("salvages unsent queued CALLs when onWebSocketClosed is called", () => {
      // Send multiple CALLs; only the first will go to wire (slot held)
      handler.sendHeartbeat();
      handler.sendStatusNotification(0, OCPPStatus.Available);
      handler.sendStatusNotification(1, OCPPStatus.Preparing);

      const heartbeatId = fakeSocket.pendingSettlements[0].id;

      // Settle Heartbeat as written
      fakeSocket.settleSynchronously(heartbeatId, { outcome: "written" });

      // At this point: _serialQueue has 2 StatusNotifications still queued
      // Call onWebSocketClosed
      handler.onWebSocketClosed();

      // Both queued CALLs should be salvaged/dropped (depending on type)
      // The handler clears the queue and logs salvage/drop for each
    });
  });

  describe("send-false handling", () => {
    it("send-false returns false and does not invoke settlement callback", () => {
      fakeSocket.disconnect();

      handler.sendHeartbeat();

      // send-false never invokes onSettled, so no pending settlements
      expect(fakeSocket.getPendingCount()).toBe(0);
    });

    it("send-false followed by pump tries the next CALL when reconnected", () => {
      // Disconnect to cause send-false
      fakeSocket.disconnect();

      handler.sendHeartbeat();

      // Reconnect
      fakeSocket.reconnect();

      // Send a second CALL
      let secondSendActionCalled = false;
      const origSendAction = fakeSocket.sendAction.bind(fakeSocket);
      fakeSocket.sendAction = (id, action, payload, gen, onSettled) => {
        if (action === "StatusNotification") {
          secondSendActionCalled = true;
        }
        return origSendAction(id, action, payload, gen, onSettled);
      };

      handler.sendStatusNotification(0, OCPPStatus.Available);

      // The second CALL should go to wire (pump continued after send-false)
      expect(secondSendActionCalled).toBe(true);
    });
  });

  describe("settlement drops and salvage", () => {
    it("socket_closed drop does NOT pump (slot stays clear)", () => {
      handler.sendHeartbeat();
      const heartbeatId = fakeSocket.pendingSettlements[0].id;

      handler.sendStatusNotification(0, OCPPStatus.Available);

      // Settle Heartbeat as socket_closed (queued, never written)
      fakeSocket.settleSynchronously(heartbeatId, {
        outcome: "socket_closed",
        closeCause: "network",
      });

      // StatusNotification should still be queued and NOT sent (pump did not run)
      expect(fakeSocket.getPendingCount()).toBe(0);
    });
  });

  describe("queued to written phase transition", () => {
    it("slot blocks subsequent CALLs during queued phase", () => {
      handler.sendHeartbeat();
      expect(fakeSocket.getPendingCount()).toBe(1);

      // Slot is "queued" now. Send another CALL — should NOT go to wire.
      handler.sendStatusNotification(0, OCPPStatus.Available);
      expect(fakeSocket.getPendingCount()).toBe(1); // Still only Heartbeat in-flight
      // StatusNotification is queued, not sent to wire
    });
  });

  describe("multiple queued CALLs", () => {
    it("processes queued CALLs one at a time after each settlement timeout", () => {
      handler.sendHeartbeat();
      handler.sendStatusNotification(0, OCPPStatus.Available);
      handler.sendStatusNotification(1, OCPPStatus.Preparing);

      const heartbeatId = fakeSocket.pendingSettlements[0].id;

      // Only Heartbeat should be in-flight
      expect(fakeSocket.getPendingCount()).toBe(1);

      // Settle Heartbeat as written
      fakeSocket.settleSynchronously(heartbeatId, { outcome: "written" });

      // Advance past the 30s timeout
      vi.advanceTimersByTime(30_000 + 1);

      // The first StatusNotification should now be in-flight
      expect(fakeSocket.getPendingCount()).toBe(1);
      const statusId1 = fakeSocket.pendingSettlements[0].id;

      // Settle it and advance past timeout
      fakeSocket.settleSynchronously(statusId1, { outcome: "written" });
      vi.advanceTimersByTime(30_000 + 1);

      // The second StatusNotification should now be in-flight
      expect(fakeSocket.getPendingCount()).toBe(1);
    });
  });
});
