import { ErrorCode, MessageType } from "@voltbras/ts-ocpp/dist/ws";
import {
  BootNotificationRequest,
  ReserveNowRequest,
  CancelReservationRequest,
} from "@voltbras/ts-ocpp/dist/messages/json/request";
import {
  ReserveNowResponse,
  CancelReservationResponse,
} from "@voltbras/ts-ocpp/dist/messages/json/response";
import { LogLevel, LogType } from "../../shared/Logger";

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

export type OCPPAvailability = "Operative" | "Inoperative";

// Re-export MessageType from ts-ocpp for convenience
export { MessageType as OCPPMessageType };

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
  DiagnosticsStatusNotification = "DiagnosticsStatusNotification", // TODO
  FirmwareStatusNotification = "FirmwareStatusNotification", // TODO
  UpdateFirmware = "UpdateFirmware", // TODO
  // LocalAuthListManagement actions
  GetLocalListVersion = "GetLocalListVersion", // TODO
  SendLocalList = "SendLocalList", // TODO
  // Reservation actions
  CancelReservation = "CancelReservation", // TODO
  ReserveNow = "ReserveNow", // TODO
  // SmartCharging actions
  ClearChargingProfile = "ClearChargingProfile", // TODO
  GetCompositeSchedule = "GetCompositeSchedule", // TODO
  SetChargingProfile = "SetChargingProfile", // TODO
  // RemoteTrigger actions
  TriggerMessage = "TriggerMessage",
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

export type OCPPErrorCode = ErrorCode;

// Re-export BootNotificationRequest from ts-ocpp
export type BootNotification = BootNotificationRequest;

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

// Re-export reservation request/response types from ts-ocpp
export type ReserveNow = ReserveNowRequest;
export type ReserveNowResponseType = ReserveNowResponse;
export type CancelReservation = CancelReservationRequest;
export type CancelReservationResponseType = CancelReservationResponse;
