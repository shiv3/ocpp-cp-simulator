// The OCPP 1.6 payload unions the handler dispatches on (#877).
import type {
  AuthorizeResponseV16,
  BootNotificationResponseV16,
  CancelReservationRequestV16,
  CertificateSignedRequestV16,
  ChangeAvailabilityRequestV16,
  ChangeConfigurationRequestV16,
  ChangeConfigurationResponseV16,
  ClearCacheRequestV16,
  ClearChargingProfileRequestV16,
  DataTransferResponseV16,
  DeleteCertificateRequestV16,
  DiagnosticsStatusNotificationResponseV16,
  ExtendedTriggerMessageRequestV16,
  FirmwareStatusNotificationResponseV16,
  GetCompositeScheduleRequestV16,
  GetConfigurationRequestV16,
  GetDiagnosticsRequestV16,
  GetInstalledCertificateIdsRequestV16,
  GetLocalListVersionRequestV16,
  GetLogRequestV16,
  HeartbeatResponseV16,
  InstallCertificateRequestV16,
  LogStatusNotificationResponseV16,
  MeterValuesResponseV16,
  RemoteStartTransactionRequestV16,
  RemoteStopTransactionRequestV16,
  ReserveNowRequestV16,
  ResetRequestV16,
  SecurityEventNotificationResponseV16,
  SendLocalListRequestV16,
  SetChargingProfileRequestV16,
  SignCertificateResponseV16,
  SignedFirmwareStatusNotificationResponseV16,
  SignedUpdateFirmwareRequestV16,
  StartTransactionResponseV16,
  StatusNotificationResponseV16,
  StopTransactionResponseV16,
  TriggerMessageRequestV16,
  UnlockConnectorRequestV16,
  UpdateFirmwareRequestV16,
} from "@ocpp-cp-simulator/ocpp";

type CoreOcppMessagePayloadCall =
  | ChangeAvailabilityRequestV16
  | ChangeConfigurationRequestV16
  | ClearCacheRequestV16
  | GetConfigurationRequestV16
  | RemoteStartTransactionRequestV16
  | RemoteStopTransactionRequestV16
  | ResetRequestV16
  | UnlockConnectorRequestV16;

type FirmwareManagementOcppMessagePayloadCall =
  | GetDiagnosticsRequestV16
  | UpdateFirmwareRequestV16
  | SignedUpdateFirmwareRequestV16;

type LocalAuthListManagementOcppMessagePayloadCall =
  GetLocalListVersionRequestV16 | SendLocalListRequestV16;

type ReservationOcppMessagePayloadCall =
  CancelReservationRequestV16 | ReserveNowRequestV16;

type SmartChargingOcppMessagePayloadCall =
  | ClearChargingProfileRequestV16
  | GetCompositeScheduleRequestV16
  | SetChargingProfileRequestV16;

type RemoteTriggerOcppMessagePayloadCall =
  TriggerMessageRequestV16 | ExtendedTriggerMessageRequestV16;

type SecurityExtensionOcppMessagePayloadCall =
  | CertificateSignedRequestV16
  | InstallCertificateRequestV16
  | GetInstalledCertificateIdsRequestV16
  | DeleteCertificateRequestV16
  | GetLogRequestV16;

export type OcppMessagePayloadCall =
  | CoreOcppMessagePayloadCall
  | FirmwareManagementOcppMessagePayloadCall
  | LocalAuthListManagementOcppMessagePayloadCall
  | ReservationOcppMessagePayloadCall
  | SmartChargingOcppMessagePayloadCall
  | RemoteTriggerOcppMessagePayloadCall
  | SecurityExtensionOcppMessagePayloadCall;

type CoreOcppMessagePayloadCallResult =
  | AuthorizeResponseV16
  | BootNotificationResponseV16
  | ChangeConfigurationResponseV16
  | DataTransferResponseV16
  | HeartbeatResponseV16
  | MeterValuesResponseV16
  | StartTransactionResponseV16
  | StatusNotificationResponseV16
  | StopTransactionResponseV16;

type FirmwareManagementOcppMessagePayloadCallResult =
  | DiagnosticsStatusNotificationResponseV16
  | FirmwareStatusNotificationResponseV16
  | SignedFirmwareStatusNotificationResponseV16;

type SecurityExtensionOcppMessagePayloadCallResult =
  | SecurityEventNotificationResponseV16
  | SignCertificateResponseV16
  | LogStatusNotificationResponseV16;

export type OcppMessagePayloadCallResult =
  | CoreOcppMessagePayloadCallResult
  | FirmwareManagementOcppMessagePayloadCallResult
  | SecurityExtensionOcppMessagePayloadCallResult;
