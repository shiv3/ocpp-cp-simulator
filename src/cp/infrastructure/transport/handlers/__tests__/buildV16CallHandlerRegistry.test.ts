import { describe, expect, it } from "vitest";
import { buildV16CallHandlerRegistry, MessageHandlerRegistry } from "../index";
import { OCPPAction } from "../../../../domain/types/OcppTypes";

describe("buildV16CallHandlerRegistry", () => {
  it("returns a MessageHandlerRegistry instance", () => {
    const registry = buildV16CallHandlerRegistry();
    expect(registry).toBeInstanceOf(MessageHandlerRegistry);
  });

  describe("CALL handlers", () => {
    it("registers all OCPP 1.6 CALL handlers", () => {
      const registry = buildV16CallHandlerRegistry();

      // Core messaging
      expect(
        registry.getCallHandler(OCPPAction.RemoteStartTransaction),
      ).toBeDefined();
      expect(
        registry.getCallHandler(OCPPAction.RemoteStopTransaction),
      ).toBeDefined();
      expect(registry.getCallHandler(OCPPAction.Reset)).toBeDefined();
      expect(registry.getCallHandler(OCPPAction.GetDiagnostics)).toBeDefined();
      expect(registry.getCallHandler(OCPPAction.TriggerMessage)).toBeDefined();
      expect(
        registry.getCallHandler(OCPPAction.GetConfiguration),
      ).toBeDefined();
      expect(
        registry.getCallHandler(OCPPAction.ChangeConfiguration),
      ).toBeDefined();
      expect(registry.getCallHandler(OCPPAction.ClearCache)).toBeDefined();
      expect(registry.getCallHandler(OCPPAction.UnlockConnector)).toBeDefined();

      // Reservation management
      expect(registry.getCallHandler(OCPPAction.ReserveNow)).toBeDefined();
      expect(
        registry.getCallHandler(OCPPAction.CancelReservation),
      ).toBeDefined();

      // Smart charging
      expect(
        registry.getCallHandler(OCPPAction.SetChargingProfile),
      ).toBeDefined();
      expect(
        registry.getCallHandler(OCPPAction.ClearChargingProfile),
      ).toBeDefined();
      expect(
        registry.getCallHandler(OCPPAction.GetCompositeSchedule),
      ).toBeDefined();

      // Availability management
      expect(
        registry.getCallHandler(OCPPAction.ChangeAvailability),
      ).toBeDefined();

      // Local auth list management
      expect(
        registry.getCallHandler(OCPPAction.GetLocalListVersion),
      ).toBeDefined();
      expect(registry.getCallHandler(OCPPAction.SendLocalList)).toBeDefined();

      // Firmware management
      expect(registry.getCallHandler(OCPPAction.UpdateFirmware)).toBeDefined();

      // Security management
      expect(
        registry.getCallHandler(OCPPAction.CertificateSigned),
      ).toBeDefined();
      expect(
        registry.getCallHandler(OCPPAction.ExtendedTriggerMessage),
      ).toBeDefined();
      expect(
        registry.getCallHandler(OCPPAction.InstallCertificate),
      ).toBeDefined();
      expect(
        registry.getCallHandler(OCPPAction.GetInstalledCertificateIds),
      ).toBeDefined();
      expect(
        registry.getCallHandler(OCPPAction.DeleteCertificate),
      ).toBeDefined();
      expect(registry.getCallHandler(OCPPAction.GetLog)).toBeDefined();
      expect(
        registry.getCallHandler(OCPPAction.SignedUpdateFirmware),
      ).toBeDefined();
    });

    it("does NOT register DataTransfer CALL handler (instance-specific)", () => {
      const registry = buildV16CallHandlerRegistry();
      // DataTransfer CALL handler is intentionally not registered by the
      // factory because it must be instance-specific (scenarios register
      // vendor responders via getDataTransferHandler()).
      expect(registry.getCallHandler(OCPPAction.DataTransfer)).toBeUndefined();
    });

    it("returns undefined for unregistered CALL actions", () => {
      const registry = buildV16CallHandlerRegistry();
      // Use an action that shouldn't be registered as a CALL (e.g., a CALLRESULT-only action)
      expect(registry.getCallHandler(OCPPAction.Authorize)).toBeUndefined();
      expect(
        registry.getCallHandler(OCPPAction.StartTransaction),
      ).toBeUndefined();
      expect(
        registry.getCallHandler(OCPPAction.StopTransaction),
      ).toBeUndefined();
    });
  });

  describe("CALLRESULT handlers", () => {
    it("registers the stateless OCPP 1.6 CALLRESULT handlers", () => {
      const registry = buildV16CallHandlerRegistry();

      expect(
        registry.getCallResultHandler(OCPPAction.BootNotification),
      ).toBeDefined();
      expect(registry.getCallResultHandler(OCPPAction.Heartbeat)).toBeDefined();
      expect(
        registry.getCallResultHandler(OCPPAction.StatusNotification),
      ).toBeDefined();
      expect(
        registry.getCallResultHandler(OCPPAction.DataTransfer),
      ).toBeDefined();
    });

    it("does NOT register Authorize CALLRESULT handler (per-request, needs the request's idTag — #181)", () => {
      const registry = buildV16CallHandlerRegistry();
      // Mirrors StartTransaction/StopTransaction/MeterValues below:
      // OCPPMessageHandler.handleCallResult constructs it dynamically from
      // request.payload so it can correlate the `authorizeResult` event
      // with the tagId Authorize.conf itself doesn't carry.
      expect(
        registry.getCallResultHandler(OCPPAction.Authorize),
      ).toBeUndefined();
    });

    it("returns undefined for unregistered CALLRESULT actions", () => {
      const registry = buildV16CallHandlerRegistry();
      // Use actions that shouldn't be registered as CALLRESULT
      expect(
        registry.getCallResultHandler(OCPPAction.RemoteStartTransaction),
      ).toBeUndefined();
      expect(registry.getCallResultHandler(OCPPAction.Reset)).toBeUndefined();
    });
  });

  it("creates independent registries on each call", () => {
    const registry1 = buildV16CallHandlerRegistry();
    const registry2 = buildV16CallHandlerRegistry();

    // Both should be instances of MessageHandlerRegistry
    expect(registry1).toBeInstanceOf(MessageHandlerRegistry);
    expect(registry2).toBeInstanceOf(MessageHandlerRegistry);

    // But they should be distinct instances
    expect(registry1).not.toBe(registry2);

    // Both should have the same set of registered handlers
    expect(registry1.getCallHandler(OCPPAction.Reset)).toBeDefined();
    expect(registry2.getCallHandler(OCPPAction.Reset)).toBeDefined();
  });
});
