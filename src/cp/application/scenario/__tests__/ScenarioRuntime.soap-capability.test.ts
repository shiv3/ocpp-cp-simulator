import { describe, expect, it, vi } from "vitest";
import { createScenarioExecutorCallbacks } from "../ScenarioRuntime";
import { OCPPStatus } from "../../../domain/types/OcppTypes";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { Connector } from "../../../domain/connector/Connector";

/**
 * §4.9 S3: scenario engine fail-fast tests for SOAP transport capabilities.
 *
 * Verifies that RemoteStart/RemoteStop/Reservation trigger nodes fail fast
 * with a clear error when the charge point cannot receive the required
 * CSMS-initiated call, rather than hanging the scenario.
 */

function createMockChargePoint(overrides?: Partial<ChargePoint>): ChargePoint {
  const mocks: ChargePoint = {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    updateConnectorStatus: vi.fn(),
    startTransaction: vi.fn(),
    stopTransaction: vi.fn(),
    setMeterValue: vi.fn(),
    sendMeterValue: vi.fn(),
    sendHeartbeat: vi.fn(),
    sendStatusNotificationRaw: vi.fn(),
    sendDataTransfer: vi.fn(),
    getConnector: vi.fn(),
    configuration: {
      applyChange: vi.fn(),
    },
    reservationManager: {
      createReservation: vi.fn(),
      getReservation: vi.fn(),
      getReservationForConnector: vi.fn(),
      cancelReservation: vi.fn(),
    },
    registerScenarioHandler: vi.fn(),
    unregisterScenarioHandler: vi.fn(),
    registerScenarioStopHandler: vi.fn(),
    unregisterScenarioStopHandler: vi.fn(),
    events: {
      on: vi.fn(),
      off: vi.fn(),
    },
    canReceiveCsmsCall: vi.fn(),
    isSoapChargePoint: vi.fn(),
    get ocppVersion() {
      return "OCPP-1.6J";
    },
    ...overrides,
  } as unknown as ChargePoint;

  return mocks;
}

function createMockConnector(): Connector {
  return {
    id: 1,
    status: OCPPStatus.Available,
    meterValue: 0,
    unlockResponse: "UnlockFailed",
    evSettings: {
      batteryCapacityKwh: 40,
      initialSoc: 20,
      targetSoc: 80,
      stopAtTargetSoc: true,
    },
    startManualMeterStrategy: vi.fn(),
    stopAutoMeterValue: vi.fn(),
    transaction: null,
    events: {
      on: vi.fn(),
      off: vi.fn(),
    },
  } as unknown as Connector;
}

describe("ScenarioRuntime.soap-capability", () => {
  describe("waitForRemoteStart fail-fast", () => {
    it("fails fast when CP cannot receive RemoteStartTransaction (send-only SOAP)", async () => {
      const chargePoint = createMockChargePoint({
        canReceiveCsmsCall: vi.fn().mockReturnValue(false),
        isSoapChargePoint: vi.fn().mockReturnValue(true),
        get ocppVersion() {
          return "OCPP-1.5";
        },
      });
      const connector = createMockConnector();

      const callbacks = createScenarioExecutorCallbacks({
        chargePoint,
        connector,
      });

      const waitPromise = callbacks.onWaitForRemoteStart!(30);
      await expect(waitPromise).rejects.toThrow(
        /RemoteStartTransaction trigger requires a transport that can receive CSMS-initiated calls/,
      );

      // Ensure the handler was NOT registered before rejection
      expect(chargePoint.registerScenarioHandler).not.toHaveBeenCalled();
    });

    it("does NOT fail fast when CP can receive RemoteStartTransaction (1.6S+callback)", async () => {
      const chargePoint = createMockChargePoint({
        canReceiveCsmsCall: vi.fn().mockReturnValue(true),
      });
      const connector = createMockConnector();

      const callbacks = createScenarioExecutorCallbacks({
        chargePoint,
        connector,
      });

      const waitPromise = callbacks.onWaitForRemoteStart!(30);

      // Should register the handler before waiting
      expect(chargePoint.registerScenarioHandler).toHaveBeenCalledWith(1);

      // The promise should be pending, not rejected
      expect(waitPromise).toBeInstanceOf(Promise);

      // Cancel the wait to clean up
      if (waitPromise.cancel) {
        waitPromise.cancel();
      }
    });

    it("succeeds for WebSocket versions (always can receive)", async () => {
      const chargePoint = createMockChargePoint({
        canReceiveCsmsCall: vi.fn().mockReturnValue(true),
        isSoapChargePoint: vi.fn().mockReturnValue(false),
      });
      const connector = createMockConnector();

      const callbacks = createScenarioExecutorCallbacks({
        chargePoint,
        connector,
      });

      const waitPromise = callbacks.onWaitForRemoteStart!(30);

      // Should register the handler
      expect(chargePoint.registerScenarioHandler).toHaveBeenCalledWith(1);

      // Cancel the wait
      if (waitPromise.cancel) {
        waitPromise.cancel();
      }
    });
  });

  describe("waitForRemoteStop fail-fast", () => {
    it("fails fast when CP cannot receive RemoteStopTransaction (send-only SOAP)", async () => {
      const chargePoint = createMockChargePoint({
        canReceiveCsmsCall: vi.fn().mockReturnValue(false),
        isSoapChargePoint: vi.fn().mockReturnValue(true),
        get ocppVersion() {
          return "OCPP-1.2";
        },
      });
      const connector = createMockConnector();

      const callbacks = createScenarioExecutorCallbacks({
        chargePoint,
        connector,
      });

      const waitPromise = callbacks.onWaitForRemoteStop!(30);
      await expect(waitPromise).rejects.toThrow(
        /RemoteStopTransaction trigger requires a transport that can receive CSMS-initiated calls/,
      );

      // Ensure the handler was NOT registered before rejection
      expect(chargePoint.registerScenarioStopHandler).not.toHaveBeenCalled();
    });

    it("does NOT fail fast when CP can receive RemoteStopTransaction", async () => {
      const chargePoint = createMockChargePoint({
        canReceiveCsmsCall: vi.fn().mockReturnValue(true),
      });
      const connector = createMockConnector();

      const callbacks = createScenarioExecutorCallbacks({
        chargePoint,
        connector,
      });

      const waitPromise = callbacks.onWaitForRemoteStop!(30);

      // Should register the handler
      expect(chargePoint.registerScenarioStopHandler).toHaveBeenCalledWith(1);

      // Cancel the wait
      if (waitPromise.cancel) {
        waitPromise.cancel();
      }
    });
  });

  describe("waitForReservation fail-fast", () => {
    it("fails fast when CP cannot receive ReserveNow (OCPP-1.5 SOAP)", async () => {
      const chargePoint = createMockChargePoint({
        canReceiveCsmsCall: vi.fn().mockReturnValue(false),
        isSoapChargePoint: vi.fn().mockReturnValue(true),
        get ocppVersion() {
          return "OCPP-1.5";
        },
      });
      const connector = createMockConnector();

      const callbacks = createScenarioExecutorCallbacks({
        chargePoint,
        connector,
      });

      const waitPromise = callbacks.onWaitForReservation!(30);
      await expect(waitPromise).rejects.toThrow(
        /Reservation trigger requires ReserveNow capability/,
      );
    });

    it("does NOT fail fast when CP can receive ReserveNow", async () => {
      const chargePoint = createMockChargePoint({
        canReceiveCsmsCall: vi.fn().mockReturnValue(true),
        reservationManager: {
          getReservationForConnector: vi.fn().mockReturnValue(null),
        },
      });
      const connector = createMockConnector();

      const callbacks = createScenarioExecutorCallbacks({
        chargePoint,
        connector,
      });

      const waitPromise = callbacks.onWaitForReservation!(30);

      // The promise should be pending, not rejected
      expect(waitPromise).toBeInstanceOf(Promise);
    });

    it("resolves immediately when reservation already exists", async () => {
      const chargePoint = createMockChargePoint({
        canReceiveCsmsCall: vi.fn().mockReturnValue(true),
        reservationManager: {
          getReservationForConnector: vi
            .fn()
            .mockReturnValue({ reservationId: 12345 }),
        },
      });
      const connector = createMockConnector();

      const callbacks = createScenarioExecutorCallbacks({
        chargePoint,
        connector,
      });

      const waitPromise = callbacks.onWaitForReservation!(30);
      const result = await waitPromise;

      expect(result).toBe(12345);
    });
  });
});
