import { describe, expect, it } from "vitest";
import { ChargePoint } from "../ChargePoint";
import type { BootNotification } from "../../types/OcppTypes";
import { DefaultBootNotification } from "../../types/OcppTypes";

/**
 * §4.9 S3: ChargePoint CSMS-capability matrix unit tests.
 *
 * Verifies that `canReceiveCsmsCall(action)` correctly identifies
 * which CSMS-initiated calls the charge point can receive based on:
 * - Transport type (WebSocket vs SOAP)
 * - SOAP version (1.2 / 1.5 / 1.6S)
 * - SOAP callback URL presence (server-hosted vs send-only)
 */

const bootNotification: BootNotification = DefaultBootNotification;

describe("ChargePoint.canReceiveCsmsCall", () => {
  describe("WebSocket versions", () => {
    it("OCPP-1.6J (WebSocket) can receive all CSMS calls", () => {
      const cp = new ChargePoint(
        "test-cp-1.6j",
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

      // All CS→CP operations should be receivable
      expect(cp.canReceiveCsmsCall("RemoteStartTransaction")).toBe(true);
      expect(cp.canReceiveCsmsCall("RemoteStopTransaction")).toBe(true);
      expect(cp.canReceiveCsmsCall("ReserveNow")).toBe(true);
      expect(cp.canReceiveCsmsCall("Reset")).toBe(true);
      expect(cp.canReceiveCsmsCall("ChangeAvailability")).toBe(true);
      expect(cp.canReceiveCsmsCall("TriggerMessage")).toBe(true);
    });

    it("OCPP-2.0.1 (WebSocket) can receive all CSMS calls", () => {
      const cp = new ChargePoint(
        "test-cp-2.0.1",
        bootNotification,
        1,
        "ws://localhost:8080",
        null,
        null,
        null,
        {},
        [],
        "OCPP-2.0.1",
        {},
      );

      // All CS→CP operations should be receivable
      expect(cp.canReceiveCsmsCall("RemoteStartTransaction")).toBe(true);
      expect(cp.canReceiveCsmsCall("ReserveNow")).toBe(true);
      expect(cp.canReceiveCsmsCall("Reset")).toBe(true);
    });
  });

  describe("OCPP-1.5 SOAP", () => {
    it("OCPP-1.5 send-only (no callback) cannot receive any calls", () => {
      const cp = new ChargePoint(
        "test-cp-1.5-send-only",
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
          // No soapCallbackUrl — send-only mode
        },
      );

      // Should not be able to receive ANY CS→CP calls
      expect(cp.canReceiveCsmsCall("Reset")).toBe(false);
      expect(cp.canReceiveCsmsCall("RemoteStartTransaction")).toBe(false);
      expect(cp.canReceiveCsmsCall("ChangeAvailability")).toBe(false);
    });

    it("OCPP-1.5 with callback can only receive Reset", () => {
      const cp = new ChargePoint(
        "test-cp-1.5-callback",
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

      // OCPP-1.5 server registry is Reset-only
      expect(cp.canReceiveCsmsCall("Reset")).toBe(true);

      // Other CS→CP operations are NOT available in 1.5's server
      expect(cp.canReceiveCsmsCall("RemoteStartTransaction")).toBe(false);
      expect(cp.canReceiveCsmsCall("RemoteStopTransaction")).toBe(false);
      expect(cp.canReceiveCsmsCall("ReserveNow")).toBe(false);
      expect(cp.canReceiveCsmsCall("ChangeAvailability")).toBe(false);
    });
  });

  describe("OCPP-1.2 SOAP", () => {
    it("OCPP-1.2 send-only (no callback) cannot receive any calls", () => {
      const cp = new ChargePoint(
        "test-cp-1.2-send-only",
        bootNotification,
        1,
        "ws://localhost:8080",
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.2",
        {
          centralSystemUrl: "http://localhost:9000",
          // No soapCallbackUrl
        },
      );

      expect(cp.canReceiveCsmsCall("RemoteStartTransaction")).toBe(false);
      expect(cp.canReceiveCsmsCall("Reset")).toBe(false);
    });

    it("OCPP-1.2 with callback can receive OCPP-1.2 operations", () => {
      const cp = new ChargePoint(
        "test-cp-1.2-callback",
        bootNotification,
        1,
        "ws://localhost:8080",
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.2",
        {
          centralSystemUrl: "http://localhost:9000",
          soapCallbackUrl: "http://localhost:8001/cp",
        },
      );

      // OCPP-1.2 defines these CS→CP operations
      expect(cp.canReceiveCsmsCall("RemoteStartTransaction")).toBe(true);
      expect(cp.canReceiveCsmsCall("RemoteStopTransaction")).toBe(true);
      expect(cp.canReceiveCsmsCall("Reset")).toBe(true);
      expect(cp.canReceiveCsmsCall("ChangeAvailability")).toBe(true);
      expect(cp.canReceiveCsmsCall("GetDiagnostics")).toBe(true);

      // OCPP-1.2 does NOT define ReserveNow (it's 1.5+)
      expect(cp.canReceiveCsmsCall("ReserveNow")).toBe(false);
      expect(cp.canReceiveCsmsCall("CancelReservation")).toBe(false);
      expect(cp.canReceiveCsmsCall("GetConfiguration")).toBe(false);
    });
  });

  describe("OCPP-1.6-SOAP", () => {
    it("OCPP-1.6S send-only (no callback) cannot receive any calls", () => {
      const cp = new ChargePoint(
        "test-cp-1.6s-send-only",
        bootNotification,
        1,
        "ws://localhost:8080",
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.6S",
        {
          centralSystemUrl: "http://localhost:9000",
          // No soapCallbackUrl
        },
      );

      expect(cp.canReceiveCsmsCall("RemoteStartTransaction")).toBe(false);
      expect(cp.canReceiveCsmsCall("ReserveNow")).toBe(false);
      expect(cp.canReceiveCsmsCall("Reset")).toBe(false);
    });

    it("OCPP-1.6S with callback can receive all OCPP-1.6 operations", () => {
      const cp = new ChargePoint(
        "test-cp-1.6s-callback",
        bootNotification,
        1,
        "ws://localhost:8080",
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.6S",
        {
          centralSystemUrl: "http://localhost:9000",
          soapCallbackUrl: "http://localhost:8001/cp",
        },
      );

      // OCPP-1.6 operations (including 1.6-specific additions)
      expect(cp.canReceiveCsmsCall("RemoteStartTransaction")).toBe(true);
      expect(cp.canReceiveCsmsCall("RemoteStopTransaction")).toBe(true);
      expect(cp.canReceiveCsmsCall("ReserveNow")).toBe(true);
      expect(cp.canReceiveCsmsCall("Reset")).toBe(true);
      expect(cp.canReceiveCsmsCall("ChangeAvailability")).toBe(true);
      expect(cp.canReceiveCsmsCall("GetConfiguration")).toBe(true);
      expect(cp.canReceiveCsmsCall("SetChargingProfile")).toBe(true);
      expect(cp.canReceiveCsmsCall("ClearChargingProfile")).toBe(true);
      expect(cp.canReceiveCsmsCall("TriggerMessage")).toBe(true);
      expect(cp.canReceiveCsmsCall("GetCompositeSchedule")).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("handles unknown operations (returns false for any dialect)", () => {
      const cp = new ChargePoint(
        "test-cp-edge",
        bootNotification,
        1,
        "ws://localhost:8080",
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.6S",
        {
          centralSystemUrl: "http://localhost:9000",
          soapCallbackUrl: "http://localhost:8001/cp",
        },
      );

      // Non-existent operations should always be false
      expect(cp.canReceiveCsmsCall("FakeOperation")).toBe(false);
      expect(cp.canReceiveCsmsCall("")).toBe(false);
    });

    it("CP→CS operations (those not in dialect) return false", () => {
      const cp = new ChargePoint(
        "test-cp-cpcs",
        bootNotification,
        1,
        "ws://localhost:8080",
        null,
        null,
        null,
        {},
        [],
        "OCPP-1.6S",
        {
          centralSystemUrl: "http://localhost:9000",
          soapCallbackUrl: "http://localhost:8001/cp",
        },
      );

      // These are CP→CS (not CS→CP), so they should not be receivable
      expect(cp.canReceiveCsmsCall("StartTransaction")).toBe(false);
      expect(cp.canReceiveCsmsCall("StatusNotification")).toBe(false);
      expect(cp.canReceiveCsmsCall("BootNotification")).toBe(false);
      expect(cp.canReceiveCsmsCall("Heartbeat")).toBe(false);
    });
  });
});
