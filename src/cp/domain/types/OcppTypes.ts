import {
  OCPPErrorCodeV16,
  type BootNotificationRequestV16,
  type ReserveNowRequestV16,
  type ReserveNowResponseV16,
  type CancelReservationRequestV16,
  type CancelReservationResponseV16,
} from "../../../ocpp";
import { LogLevel, LogType } from "../../shared/Logger";

export enum OCPPMessageType {
  CALL = 2,
  CALLRESULT = 3,
  CALLERROR = 4,
}

export enum OCPPStatus {
  Available = "Available",
  Preparing = "Preparing",
  Charging = "Charging",
  SuspendedEVSE = "SuspendedEVSE",
  SuspendedEV = "SuspendedEV",
  Finishing = "Finishing",
  Reserved = "Reserved",
  Unavailable = "Unavailable",
  Faulted = "Faulted",
}

/**
 * Subset of `OCPPStatus` valid for `connectorId = 0` (the Charge Point main
 * controller), per OCPP 1.6J §7.7:
 *
 * > Status for the Charge Point main controller is a subset of the
 * > enumeration: Available, Unavailable or Faulted.
 *
 * Type-narrowing `ChargePoint._status` to this triplet stops the rest of
 * the code from accidentally driving the CP into `Charging` / `Preparing` /
 * `Reserved` etc. — those belong to individual connectors (id > 0).
 */
export type ChargePointStatus =
  OCPPStatus.Available | OCPPStatus.Unavailable | OCPPStatus.Faulted;

/**
 * Returns `true` if `status` is a valid `ChargePointStatus`. Useful when
 * narrowing untyped input (e.g. a status value coming in via
 * `updateConnectorStatus(0, …)` whose signature still has to accept the
 * wider `OCPPStatus` for back-compat).
 */
export function isChargePointStatus(
  status: OCPPStatus,
): status is ChargePointStatus {
  return (
    status === OCPPStatus.Available ||
    status === OCPPStatus.Unavailable ||
    status === OCPPStatus.Faulted
  );
}

export type OCPPAvailability = "Operative" | "Inoperative";

/**
 * Charge Point error codes — used in StatusNotification.req errorCode field
 * (OCPP 1.6 §7.6). `NoError` is the default when no fault is present;
 * other values are paired with `ChargePointStatus.Faulted` or used as a
 * warning while the connector is in Preparing/SuspendedEV/SuspendedEVSE/
 * Finishing (e.g. `EVCommunicationError`).
 */
export type ChargePointErrorCode =
  | "ConnectorLockFailure"
  | "EVCommunicationError"
  | "GroundFailure"
  | "HighTemperature"
  | "InternalError"
  | "LocalListConflict"
  | "NoError"
  | "OtherError"
  | "OverCurrentFailure"
  | "OverVoltage"
  | "PowerMeterFailure"
  | "PowerSwitchFailure"
  | "ReaderFailure"
  | "ResetFailure"
  | "UnderVoltage"
  | "WeakSignal";

export interface StatusNotificationOptions {
  errorCode?: string;
  info?: string;
  vendorErrorCode?: string;
  vendorId?: string;
  timestamp?: Date;
  suppressChargingStateTransactionEvent?: boolean;
}

export function hasStatusNotificationOptions(
  opts: StatusNotificationOptions | undefined,
): opts is StatusNotificationOptions {
  return (
    opts !== undefined &&
    (opts.errorCode !== undefined ||
      opts.info !== undefined ||
      opts.vendorErrorCode !== undefined ||
      opts.vendorId !== undefined ||
      opts.timestamp !== undefined ||
      opts.suppressChargingStateTransactionEvent !== undefined)
  );
}

export const ALL_CHARGE_POINT_ERROR_CODES: ChargePointErrorCode[] = [
  "ConnectorLockFailure",
  "EVCommunicationError",
  "GroundFailure",
  "HighTemperature",
  "InternalError",
  "LocalListConflict",
  "NoError",
  "OtherError",
  "OverCurrentFailure",
  "OverVoltage",
  "PowerMeterFailure",
  "PowerSwitchFailure",
  "ReaderFailure",
  "ResetFailure",
  "UnderVoltage",
  "WeakSignal",
];

export enum OCPPAction {
  // Core actions
  Authorize = "Authorize",
  BootNotification = "BootNotification",
  ChangeAvailability = "ChangeAvailability",
  ChangeConfiguration = "ChangeConfiguration",
  ClearCache = "ClearCache",
  DataTransfer = "DataTransfer",
  GetConfiguration = "GetConfiguration",
  Heartbeat = "Heartbeat",
  MeterValues = "MeterValues",
  RemoteStartTransaction = "RemoteStartTransaction",
  RemoteStopTransaction = "RemoteStopTransaction",
  Reset = "Reset",
  StartTransaction = "StartTransaction",
  StatusNotification = "StatusNotification",
  StopTransaction = "StopTransaction",
  UnlockConnector = "UnlockConnector",
  // FirmwareManagement actions
  GetDiagnostics = "GetDiagnostics",
  DiagnosticsStatusNotification = "DiagnosticsStatusNotification",
  FirmwareStatusNotification = "FirmwareStatusNotification",
  UpdateFirmware = "UpdateFirmware",
  // LocalAuthListManagement actions
  GetLocalListVersion = "GetLocalListVersion",
  SendLocalList = "SendLocalList",
  // Reservation actions
  CancelReservation = "CancelReservation",
  ReserveNow = "ReserveNow",
  // SmartCharging actions
  ClearChargingProfile = "ClearChargingProfile",
  GetCompositeSchedule = "GetCompositeSchedule",
  SetChargingProfile = "SetChargingProfile",
  // RemoteTrigger actions
  TriggerMessage = "TriggerMessage",
  // Security extension (1.6 Security Whitepaper)
  SecurityEventNotification = "SecurityEventNotification",
  SignCertificate = "SignCertificate",
  CertificateSigned = "CertificateSigned",
  DeleteCertificate = "DeleteCertificate",
  GetInstalledCertificateIds = "GetInstalledCertificateIds",
  InstallCertificate = "InstallCertificate",
  ExtendedTriggerMessage = "ExtendedTriggerMessage",
  SignedUpdateFirmware = "SignedUpdateFirmware",
  SignedFirmwareStatusNotification = "SignedFirmwareStatusNotification",
  LogStatusNotification = "LogStatusNotification",
  GetLog = "GetLog",
  // Fake actions
  CallResult = "CallResult",
}

export enum OcppFeatureProfile {
  // Basic Charge Point functionality comparable with OCPP 1.5 [OCPP1.5]
  // without support for firmware updates, local authorization list management and reservations.
  Core = "Core",
  // Support for firmware update management and diagnostic log file download.
  FirmwareManagement = "FirmwareManagement",
  // Features to manage the local authorization list in Charge Points.
  LocalAuthListManagement = "LocalAuthListManagement",
  // Support for reservation of a Charge Point.
  Reservation = "Reservation",
  // Support for basic Smart Charging, for instance using control pilot.
  SmartCharging = "SmartCharging",
  // Support for remote triggering of Charge Point initiated messages
  RemoteTrigger = "RemoteTrigger",
}

export type OcppConfigurationKey = {
  key: string;
  readonly: boolean;
  value?: string;
};

export type OCPPErrorCode = OCPPErrorCodeV16;

export type BootNotification = BootNotificationRequestV16;

export const DefaultBootNotification: BootNotification = {
  chargeBoxSerialNumber: "123456",
  chargePointModel: "Model",
  chargePointSerialNumber: "123456",
  chargePointVendor: "Vendor",
  firmwareVersion: "1.0",
  iccid: "",
  imsi: "",
  meterSerialNumber: "123456",
  meterType: "",
};

// Re-export Logger types for convenience
export { LogLevel, LogType };

// ============================================
// Reservation Profile Types (OCPP 1.6)
// ============================================

/**
 * ReserveNow response status values
 */
export enum ReservationStatus {
  Accepted = "Accepted",
  Faulted = "Faulted",
  Occupied = "Occupied",
  Rejected = "Rejected",
  Unavailable = "Unavailable",
}

/**
 * CancelReservation response status values
 */
export enum CancelReservationStatus {
  Accepted = "Accepted",
  Rejected = "Rejected",
}

export type ReserveNow = ReserveNowRequestV16;
export type ReserveNowResponseType = ReserveNowResponseV16;
export type CancelReservation = CancelReservationRequestV16;
export type CancelReservationResponseType = CancelReservationResponseV16;

// ============================================
// Smart Charging Profile Types (OCPP 1.6)
// ============================================

/**
 * Charging profile purpose types
 */
export enum ChargingProfilePurposeType {
  ChargePointMaxProfile = "ChargePointMaxProfile",
  TxDefaultProfile = "TxDefaultProfile",
  TxProfile = "TxProfile",
}

/**
 * Charging profile kind types
 */
export enum ChargingProfileKindType {
  Absolute = "Absolute",
  Recurring = "Recurring",
  Relative = "Relative",
}

/**
 * Charging rate unit types
 */
export enum ChargingRateUnitType {
  W = "W", // Watts
  A = "A", // Amperes
}

/**
 * Recurrency kind types (for Recurring profiles)
 */
export enum RecurrencyKindType {
  Daily = "Daily",
  Weekly = "Weekly",
}
