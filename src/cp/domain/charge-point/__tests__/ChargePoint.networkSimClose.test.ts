import { describe, expect, it, vi } from "vitest";
import { ChargePoint } from "../ChargePoint";
import type { BootNotification } from "../../types/OcppTypes";
import { DefaultBootNotification } from "../../types/OcppTypes";

const bootNotification: BootNotification = DefaultBootNotification;

describe("ChargePoint.networkSimClose — drain-before-teardown ordering", () => {
  describe("disconnect() drains before teardown", () => {
    it("WebSocket CP: disconnect() calls socket.disconnect first, then teardownAfterClose", () => {
      const cp = new ChargePoint(
        "test-cp-ws",
        bootNotification,
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

      // Spy on socket.disconnect and the internal teardown via outbox.onWebSocketClosed
      let socketDisconnectCalled = false;
      let outboxClosedCalled = false;
      const callOrder: string[] = [];

      // Mock the socket's disconnect method
      const originalDisconnect = cp["_webSocket"]!.disconnect;
      vi.spyOn(cp["_webSocket"]!, "disconnect").mockImplementation(() => {
        socketDisconnectCalled = true;
        callOrder.push("socket.disconnect");
        originalDisconnect.call(cp["_webSocket"]);
      });

      // Mock the outbox.onWebSocketClosed method
      const originalOnWebSocketClosed = cp["_outbox"].onWebSocketClosed;
      vi.spyOn(cp["_outbox"], "onWebSocketClosed").mockImplementation(() => {
        outboxClosedCalled = true;
        callOrder.push("teardownAfterClose");
        originalOnWebSocketClosed.call(cp["_outbox"]);
      });

      // Call disconnect
      cp.disconnect();

      // Verify both were called and socket.disconnect came first
      expect(socketDisconnectCalled).toBe(true);
      expect(outboxClosedCalled).toBe(true);
      expect(callOrder[0]).toBe("socket.disconnect");
      expect(callOrder[1]).toBe("teardownAfterClose");
    });

    it("SOAP CP: disconnect() skips socket disconnect", () => {
      const cp = new ChargePoint(
        "test-cp-soap",
        bootNotification,
        1,
        "ws://localhost:8080",
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.5",
        {
          centralSystemUrl: "http://localhost:9000",
          soapCallbackUrl: "http://localhost:8001/cp",
        },
      );

      // SOAP CP should have no WebSocket
      expect(cp["_webSocket"]).toBe(null);

      // Spy on teardownAfterClose via outbox.onWebSocketClosed
      let outboxClosedCalled = false;
      const originalOnWebSocketClosed = cp["_outbox"].onWebSocketClosed;
      vi.spyOn(cp["_outbox"], "onWebSocketClosed").mockImplementation(() => {
        outboxClosedCalled = true;
        originalOnWebSocketClosed.call(cp["_outbox"]);
      });

      // Call disconnect — should not throw and should teardown
      cp.disconnect();

      expect(outboxClosedCalled).toBe(true);
    });
  });

  describe("reset() uses cause-aware internal reset for WebSocket", () => {
    it("WebSocket CP: reset() calls disconnectInternal, not the operator disconnect", () => {
      const cp = new ChargePoint(
        "test-cp-ws-reset",
        bootNotification,
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

      let disconnectInternalCalled = false;
      let operatorDisconnectCalled = false;
      let connectCalled = false;

      // Spy on disconnectInternal
      vi.spyOn(cp["_webSocket"]!, "disconnectInternal").mockImplementation(
        () => {
          disconnectInternalCalled = true;
        },
      );

      // Spy on operator disconnect
      const originalDisconnect = cp["_webSocket"]!.disconnect;
      vi.spyOn(cp["_webSocket"]!, "disconnect").mockImplementation(() => {
        operatorDisconnectCalled = true;
        originalDisconnect.call(cp["_webSocket"]);
      });

      // Spy on connect
      vi.spyOn(cp, "connect").mockImplementation(() => {
        connectCalled = true;
      });

      // Call reset
      cp.reset();

      // Verify disconnectInternal was used, not operator disconnect
      expect(disconnectInternalCalled).toBe(true);
      expect(operatorDisconnectCalled).toBe(false);
      expect(connectCalled).toBe(true);
    });

    it("SOAP CP: reset() falls back to disconnect() + connect()", () => {
      const cp = new ChargePoint(
        "test-cp-soap-reset",
        bootNotification,
        1,
        "ws://localhost:8080",
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.5",
        {
          centralSystemUrl: "http://localhost:9000",
          soapCallbackUrl: "http://localhost:8001/cp",
        },
      );

      expect(cp["_webSocket"]).toBe(null);

      // For SOAP, the fallback path should use disconnect() then connect()
      let teardownCalled = false;
      const originalOnWebSocketClosed = cp["_outbox"].onWebSocketClosed;
      vi.spyOn(cp["_outbox"], "onWebSocketClosed").mockImplementation(() => {
        teardownCalled = true;
        originalOnWebSocketClosed.call(cp["_outbox"]);
      });

      // Mock connect to avoid actual connection
      vi.spyOn(cp, "connect").mockImplementation(() => {
        // No-op
      });

      cp.reset();

      // Teardown should have been called (from disconnect path)
      expect(teardownCalled).toBe(true);
    });
  });

  describe("dispose() shuts down and tears down", () => {
    it("WebSocket CP: dispose() calls socket.dispose and teardownAfterClose", () => {
      const cp = new ChargePoint(
        "test-cp-ws-dispose",
        bootNotification,
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

      let socketDisposeCalled = false;
      let teardownCalled = false;

      vi.spyOn(cp["_webSocket"]!, "dispose").mockImplementation(() => {
        socketDisposeCalled = true;
      });

      const originalOnWebSocketClosed = cp["_outbox"].onWebSocketClosed;
      vi.spyOn(cp["_outbox"], "onWebSocketClosed").mockImplementation(() => {
        teardownCalled = true;
        originalOnWebSocketClosed.call(cp["_outbox"]);
      });

      cp.dispose();

      expect(socketDisposeCalled).toBe(true);
      expect(teardownCalled).toBe(true);
    });

    it("SOAP CP: dispose() only tears down (no socket dispose)", () => {
      const cp = new ChargePoint(
        "test-cp-soap-dispose",
        bootNotification,
        1,
        "ws://localhost:8080",
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.5",
        {
          centralSystemUrl: "http://localhost:9000",
          soapCallbackUrl: "http://localhost:8001/cp",
        },
      );

      expect(cp["_webSocket"]).toBe(null);

      let teardownCalled = false;
      const originalOnWebSocketClosed = cp["_outbox"].onWebSocketClosed;
      vi.spyOn(cp["_outbox"], "onWebSocketClosed").mockImplementation(() => {
        teardownCalled = true;
        originalOnWebSocketClosed.call(cp["_outbox"]);
      });

      cp.dispose();

      expect(teardownCalled).toBe(true);
    });
  });

  describe("network-sim config forwarding", () => {
    it("setNetworkSimConfig forwards to socket for WebSocket CP", () => {
      const cp = new ChargePoint(
        "test-cp-ws-config",
        bootNotification,
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

      let configForwarded = false;
      const testConfig = { enabled: true, seed: 12345, rules: {} };

      vi.spyOn(cp["_webSocket"]!, "setNetworkSimConfig").mockImplementation(
        () => {
          configForwarded = true;
        },
      );

      cp.setNetworkSimConfig(testConfig);

      expect(configForwarded).toBe(true);
    });

    it("setNetworkSimConfig is a no-op for SOAP CP", () => {
      const cp = new ChargePoint(
        "test-cp-soap-config",
        bootNotification,
        1,
        "ws://localhost:8080",
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.5",
        {
          centralSystemUrl: "http://localhost:9000",
          soapCallbackUrl: "http://localhost:8001/cp",
        },
      );

      const testConfig = { enabled: true, seed: 12345, rules: {} };

      // Should not throw
      expect(() => cp.setNetworkSimConfig(testConfig)).not.toThrow();
    });
  });

  describe("network-sim disconnect trigger", () => {
    it("WebSocket CP: triggerNetworkSimDisconnect forwards to socket", () => {
      const cp = new ChargePoint(
        "test-cp-ws-trigger",
        bootNotification,
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

      const mockResult = { ok: true as const };
      vi.spyOn(
        cp["_webSocket"]!,
        "triggerNetworkSimDisconnect",
      ).mockReturnValue(mockResult);

      const result = cp.triggerNetworkSimDisconnect("test-rule-id");

      expect(result).toEqual(mockResult);
    });

    it("WebSocket CP: triggerNetworkSimDisconnect forwards error responses from socket", () => {
      const cp = new ChargePoint(
        "test-cp-ws-trigger-error",
        bootNotification,
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

      const mockError = { ok: false as const, error: "sim_disabled" as const };
      vi.spyOn(
        cp["_webSocket"]!,
        "triggerNetworkSimDisconnect",
      ).mockReturnValue(mockError);

      const result = cp.triggerNetworkSimDisconnect("test-rule-id");

      expect(result).toEqual(mockError);
    });

    it("SOAP CP: triggerNetworkSimDisconnect returns not_connected", () => {
      const cp = new ChargePoint(
        "test-cp-soap-trigger",
        bootNotification,
        1,
        "ws://localhost:8080",
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.5",
        {
          centralSystemUrl: "http://localhost:9000",
          soapCallbackUrl: "http://localhost:8001/cp",
        },
      );

      const result = cp.triggerNetworkSimDisconnect("test-rule-id");

      expect(result).toEqual({ ok: false, error: "not_connected" });
    });
  });
});
