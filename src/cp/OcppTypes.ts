import {ErrorCode} from "@voltbras/ts-ocpp/dist/ws";

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

export type OCPPAvailability = "Operative" | "Inoperative"

export enum OCPPMessageType {
  CALL = 2,
  CALL_RESULT = 3,
  CALL_ERROR = 4,
}

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
}

export type OCPPErrorCode = ErrorCode;

export interface BootNotification {
  ChargeBoxSerialNumber: string;
  ChargePointModel: string;
  ChargePointSerialNumber: string;
  ChargePointVendor: string;
  FirmwareVersion: string;
  Iccid: string;
  Imsi: string;
  MeterSerialNumber: string;
  MeterType: string;
}

export const DefaultBootNotification = {
  ChargeBoxSerialNumber: "123456",
  ChargePointModel: "Model",
  ChargePointSerialNumber: "123456",
  ChargePointVendor: "Vendor",
  FirmwareVersion: "1.0",
  Iccid: "",
  Imsi: "",
  MeterSerialNumber: "123456",
  MeterType: "",
} as BootNotification;
