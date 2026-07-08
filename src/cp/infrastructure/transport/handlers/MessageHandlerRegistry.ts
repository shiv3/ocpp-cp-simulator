import type {
  AuthorizeResponseV16,
  BootNotificationResponseV16,
  CancelReservationRequestV16,
  CancelReservationResponseV16,
  CertificateSignedRequestV16,
  CertificateSignedResponseV16,
  ChangeConfigurationRequestV16,
  ChangeConfigurationResponseV16,
  ClearCacheRequestV16,
  ClearCacheResponseV16,
  DataTransferResponseV16,
  DeleteCertificateRequestV16,
  DeleteCertificateResponseV16,
  ExtendedTriggerMessageRequestV16,
  ExtendedTriggerMessageResponseV16,
  GetConfigurationRequestV16,
  GetConfigurationResponseV16,
  GetDiagnosticsRequestV16,
  GetDiagnosticsResponseV16,
  GetInstalledCertificateIdsRequestV16,
  GetInstalledCertificateIdsResponseV16,
  GetLocalListVersionRequestV16,
  GetLocalListVersionResponseV16,
  GetLogRequestV16,
  GetLogResponseV16,
  HeartbeatResponseV16,
  InstallCertificateRequestV16,
  InstallCertificateResponseV16,
  MeterValuesResponseV16,
  RemoteStartTransactionRequestV16,
  RemoteStartTransactionResponseV16,
  RemoteStopTransactionRequestV16,
  RemoteStopTransactionResponseV16,
  ReserveNowRequestV16,
  ReserveNowResponseV16,
  ResetRequestV16,
  ResetResponseV16,
  SendLocalListRequestV16,
  SendLocalListResponseV16,
  SignedUpdateFirmwareRequestV16,
  SignedUpdateFirmwareResponseV16,
  StartTransactionResponseV16,
  StatusNotificationResponseV16,
  StopTransactionResponseV16,
  TriggerMessageRequestV16,
  TriggerMessageResponseV16,
  UnlockConnectorRequestV16,
  UnlockConnectorResponseV16,
  UpdateFirmwareRequestV16,
  UpdateFirmwareResponseV16,
} from "../../../../ocpp";
import { OCPPAction } from "../../../../domain/types/OcppTypes";
import type { ChargePoint } from "../../../../domain/charge-point/ChargePoint";
import { Logger } from "../../../../shared/Logger";

/**
 * Context provided to message handlers
 */
export interface HandlerContext {
  chargePoint: ChargePoint;
  logger: Logger;
}

/**
 * Interface for handling CALL messages (requests from central system to charge point).
 *
 * `handle()` may return its response synchronously or as a `Promise` — the
 * latter is needed by handlers that compute certificate hashes via
 * WebCrypto (GetInstalledCertificateIds/DeleteCertificate). The dispatch
 * loop (`OCPPMessageHandler.handleCall`) awaits the result either way.
 */
export interface CallHandler<TRequest = unknown, TResponse = unknown> {
  handle(
    payload: TRequest,
    context: HandlerContext,
  ): TResponse | Promise<TResponse>;
}

/**
 * Interface for handling CALLRESULT messages (responses from central system to charge point)
 */
export interface CallResultHandler<TPayload = unknown> {
  handle(payload: TPayload, context: HandlerContext): void;
}

/**
 * Registry for message handlers using Strategy Pattern
 */
export class MessageHandlerRegistry {
  private callHandlers: Map<OCPPAction, CallHandler<unknown, unknown>> =
    new Map();

  private callResultHandlers: Map<OCPPAction, CallResultHandler<unknown>> =
    new Map();

  /**
   * Register a handler for CALL messages (incoming requests)
   */
  registerCallHandler<TRequest, TResponse>(
    action: OCPPAction,
    handler: CallHandler<TRequest, TResponse>,
  ): void {
    this.callHandlers.set(action, handler as CallHandler<unknown, unknown>);
  }

  /**
   * Register a handler for CALLRESULT messages (incoming responses)
   */
  registerCallResultHandler<TPayload>(
    action: OCPPAction,
    handler: CallResultHandler<TPayload>,
  ): void {
    this.callResultHandlers.set(action, handler as CallResultHandler<unknown>);
  }

  /**
   * Get handler for CALL messages
   */
  getCallHandler(
    action: OCPPAction,
  ): CallHandler<unknown, unknown> | undefined {
    return this.callHandlers.get(action);
  }

  /**
   * Get handler for CALLRESULT messages
   */
  getCallResultHandler(
    action: OCPPAction,
  ): CallResultHandler<unknown> | undefined {
    return this.callResultHandlers.get(action);
  }

  /**
   * Check if a CALL handler is registered
   */
  hasCallHandler(action: OCPPAction): boolean {
    return this.callHandlers.has(action);
  }

  /**
   * Check if a CALLRESULT handler is registered
   */
  hasCallResultHandler(action: OCPPAction): boolean {
    return this.callResultHandlers.has(action);
  }
}

// Type-safe handler factory helpers
export type CallHandlerMap = {
  [OCPPAction.RemoteStartTransaction]: CallHandler<
    RemoteStartTransactionRequestV16,
    RemoteStartTransactionResponseV16
  >;
  [OCPPAction.RemoteStopTransaction]: CallHandler<
    RemoteStopTransactionRequestV16,
    RemoteStopTransactionResponseV16
  >;
  [OCPPAction.Reset]: CallHandler<ResetRequestV16, ResetResponseV16>;
  [OCPPAction.GetDiagnostics]: CallHandler<
    GetDiagnosticsRequestV16,
    GetDiagnosticsResponseV16
  >;
  [OCPPAction.TriggerMessage]: CallHandler<
    TriggerMessageRequestV16,
    TriggerMessageResponseV16
  >;
  [OCPPAction.GetConfiguration]: CallHandler<
    GetConfigurationRequestV16,
    GetConfigurationResponseV16
  >;
  [OCPPAction.ChangeConfiguration]: CallHandler<
    ChangeConfigurationRequestV16,
    ChangeConfigurationResponseV16
  >;
  [OCPPAction.ClearCache]: CallHandler<
    ClearCacheRequestV16,
    ClearCacheResponseV16
  >;
  [OCPPAction.UnlockConnector]: CallHandler<
    UnlockConnectorRequestV16,
    UnlockConnectorResponseV16
  >;
  [OCPPAction.ReserveNow]: CallHandler<
    ReserveNowRequestV16,
    ReserveNowResponseV16
  >;
  [OCPPAction.CancelReservation]: CallHandler<
    CancelReservationRequestV16,
    CancelReservationResponseV16
  >;
  [OCPPAction.GetLocalListVersion]: CallHandler<
    GetLocalListVersionRequestV16,
    GetLocalListVersionResponseV16
  >;
  [OCPPAction.SendLocalList]: CallHandler<
    SendLocalListRequestV16,
    SendLocalListResponseV16
  >;
  [OCPPAction.UpdateFirmware]: CallHandler<
    UpdateFirmwareRequestV16,
    UpdateFirmwareResponseV16
  >;
  [OCPPAction.CertificateSigned]: CallHandler<
    CertificateSignedRequestV16,
    CertificateSignedResponseV16
  >;
  [OCPPAction.ExtendedTriggerMessage]: CallHandler<
    ExtendedTriggerMessageRequestV16,
    ExtendedTriggerMessageResponseV16
  >;
  [OCPPAction.InstallCertificate]: CallHandler<
    InstallCertificateRequestV16,
    InstallCertificateResponseV16
  >;
  [OCPPAction.GetInstalledCertificateIds]: CallHandler<
    GetInstalledCertificateIdsRequestV16,
    GetInstalledCertificateIdsResponseV16
  >;
  [OCPPAction.DeleteCertificate]: CallHandler<
    DeleteCertificateRequestV16,
    DeleteCertificateResponseV16
  >;
  [OCPPAction.GetLog]: CallHandler<GetLogRequestV16, GetLogResponseV16>;
  [OCPPAction.SignedUpdateFirmware]: CallHandler<
    SignedUpdateFirmwareRequestV16,
    SignedUpdateFirmwareResponseV16
  >;
};

export type CallResultHandlerMap = {
  [OCPPAction.BootNotification]: CallResultHandler<BootNotificationResponseV16>;
  [OCPPAction.Authorize]: CallResultHandler<AuthorizeResponseV16>;
  [OCPPAction.StartTransaction]: CallResultHandler<StartTransactionResponseV16>;
  [OCPPAction.StopTransaction]: CallResultHandler<StopTransactionResponseV16>;
  [OCPPAction.Heartbeat]: CallResultHandler<HeartbeatResponseV16>;
  [OCPPAction.MeterValues]: CallResultHandler<MeterValuesResponseV16>;
  [OCPPAction.StatusNotification]: CallResultHandler<StatusNotificationResponseV16>;
  [OCPPAction.DataTransfer]: CallResultHandler<DataTransferResponseV16>;
};
