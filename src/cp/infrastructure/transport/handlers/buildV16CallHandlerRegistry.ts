import { OCPPAction } from "../../../domain/types/OcppTypes";
import {
  MessageHandlerRegistry,
  RemoteStartTransactionHandler,
  RemoteStopTransactionHandler,
  ResetHandler,
  GetDiagnosticsHandler,
  GetConfigurationHandler,
  TriggerMessageHandler,
  ChangeConfigurationHandler,
  ClearCacheHandler,
  UnlockConnectorHandler,
  ReserveNowHandler,
  CancelReservationHandler,
  SetChargingProfileHandler,
  ClearChargingProfileHandler,
  GetCompositeScheduleHandler,
  ChangeAvailabilityHandler,
  GetLocalListVersionHandler,
  SendLocalListHandler,
  UpdateFirmwareHandler,
  CertificateSignedHandler,
  ExtendedTriggerMessageHandler,
  InstallCertificateHandler,
  GetInstalledCertificateIdsHandler,
  DeleteCertificateHandler,
  GetLogHandler,
  SignedUpdateFirmwareHandler,
  BootNotificationResultHandler,
  HeartbeatResultHandler,
  StatusNotificationResultHandler,
  DataTransferResultHandler,
} from "./index";

/**
 * Factory function to build the OCPP 1.6 CALL-handler registry.
 *
 * This factory creates and populates a MessageHandlerRegistry with all OCPP 1.6
 * CALL handlers that can be statically instantiated (without closing over
 * instance state). It is shared between WebSocket and SOAP transports to
 * enable code reuse and consistent behavior.
 *
 * Note: The DataTransfer CALL handler is intentionally NOT registered here
 * because it must be instance-specific (callers can register their own
 * instance via registerCallHandler). CALLRESULT handlers are included here
 * as they are all stateless.
 *
 * @returns A fully populated MessageHandlerRegistry for OCPP 1.6 CS→CP dispatch
 */
export function buildV16CallHandlerRegistry(): MessageHandlerRegistry {
  const registry = new MessageHandlerRegistry();

  // Register CALL handlers (incoming requests from central system)
  // Core messaging
  registry.registerCallHandler(
    OCPPAction.RemoteStartTransaction,
    new RemoteStartTransactionHandler(),
  );
  registry.registerCallHandler(
    OCPPAction.RemoteStopTransaction,
    new RemoteStopTransactionHandler(),
  );
  registry.registerCallHandler(OCPPAction.Reset, new ResetHandler());
  registry.registerCallHandler(
    OCPPAction.GetDiagnostics,
    new GetDiagnosticsHandler(),
  );
  registry.registerCallHandler(
    OCPPAction.TriggerMessage,
    new TriggerMessageHandler(),
  );
  registry.registerCallHandler(
    OCPPAction.GetConfiguration,
    new GetConfigurationHandler(),
  );
  registry.registerCallHandler(
    OCPPAction.ChangeConfiguration,
    new ChangeConfigurationHandler(),
  );
  registry.registerCallHandler(OCPPAction.ClearCache, new ClearCacheHandler());
  registry.registerCallHandler(
    OCPPAction.UnlockConnector,
    new UnlockConnectorHandler(),
  );

  // Reservation management
  registry.registerCallHandler(OCPPAction.ReserveNow, new ReserveNowHandler());
  registry.registerCallHandler(
    OCPPAction.CancelReservation,
    new CancelReservationHandler(),
  );

  // Smart charging
  registry.registerCallHandler(
    OCPPAction.SetChargingProfile,
    new SetChargingProfileHandler(),
  );
  registry.registerCallHandler(
    OCPPAction.ClearChargingProfile,
    new ClearChargingProfileHandler(),
  );
  registry.registerCallHandler(
    OCPPAction.GetCompositeSchedule,
    new GetCompositeScheduleHandler(),
  );

  // Availability management
  // §5.2: ChangeAvailability is Core. Without this, CSMS can't put the
  // CP or any connector into maintenance.
  registry.registerCallHandler(
    OCPPAction.ChangeAvailability,
    new ChangeAvailabilityHandler(),
  );

  // Local auth list management
  // §9 LocalAuthListManagement
  registry.registerCallHandler(
    OCPPAction.GetLocalListVersion,
    new GetLocalListVersionHandler(),
  );
  registry.registerCallHandler(
    OCPPAction.SendLocalList,
    new SendLocalListHandler(),
  );

  // Firmware management
  // §6.19 FirmwareManagement: UpdateFirmware. (GetDiagnostics is registered
  // above; the matching outbound status notifications fire from inside
  // ChargePoint.simulateFirmwareUpdate / the GetDiagnostics handler — there
  // is no CALLRESULT counterpart to register.)
  registry.registerCallHandler(
    OCPPAction.UpdateFirmware,
    new UpdateFirmwareHandler(),
  );

  // Security management
  registry.registerCallHandler(
    OCPPAction.CertificateSigned,
    new CertificateSignedHandler(),
  );

  // OCPP 1.6 Security Whitepaper (ed. 4): remaining message set —
  // ExtendedTriggerMessage/InstallCertificate/GetInstalledCertificateIds/
  // DeleteCertificate/GetLog/SignedUpdateFirmware. Matching outbound
  // status notifications fire from inside the handlers themselves (or,
  // for SignedUpdateFirmware, ChargePoint.simulateSignedFirmwareUpdate) —
  // there is no CALLRESULT counterpart to register for any of these.
  registry.registerCallHandler(
    OCPPAction.ExtendedTriggerMessage,
    new ExtendedTriggerMessageHandler(),
  );
  registry.registerCallHandler(
    OCPPAction.InstallCertificate,
    new InstallCertificateHandler(),
  );
  registry.registerCallHandler(
    OCPPAction.GetInstalledCertificateIds,
    new GetInstalledCertificateIdsHandler(),
  );
  registry.registerCallHandler(
    OCPPAction.DeleteCertificate,
    new DeleteCertificateHandler(),
  );
  registry.registerCallHandler(OCPPAction.GetLog, new GetLogHandler());
  registry.registerCallHandler(
    OCPPAction.SignedUpdateFirmware,
    new SignedUpdateFirmwareHandler(),
  );

  // NOTE: DataTransfer CALL handler is intentionally NOT registered here.
  // It must be instance-specific (see OCPPMessageHandler constructor) so
  // scenarios can register vendor responders via getDataTransferHandler().
  // Callers should register it via registry.registerCallHandler after
  // factory construction if they need instance-specific behavior.

  // Register CALLRESULT handlers (incoming responses from central system)
  registry.registerCallResultHandler(
    OCPPAction.BootNotification,
    new BootNotificationResultHandler(),
  );
  // NOTE: Authorize CALLRESULT handler is intentionally NOT registered
  // here (issue #181). It needs the original Authorize.req's idTag to
  // correlate the `authorizeResult` event, so OCPPMessageHandler.
  // handleCallResult constructs it per-request from `request.payload`,
  // mirroring StartTransaction/StopTransaction/MeterValues below.
  registry.registerCallResultHandler(
    OCPPAction.Heartbeat,
    new HeartbeatResultHandler(),
  );
  registry.registerCallResultHandler(
    OCPPAction.StatusNotification,
    new StatusNotificationResultHandler(),
  );
  registry.registerCallResultHandler(
    OCPPAction.DataTransfer,
    new DataTransferResultHandler(),
  );

  return registry;
}
