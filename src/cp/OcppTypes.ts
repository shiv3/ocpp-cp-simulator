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

export enum OCPPAvailability {
  Operative = "Operative",
  Inoperative = "Inoperative",
}

export enum OCPPMessageType {
  CALL = 2,
  CALL_RESULT = 3,
  CALL_ERROR = 4,
}

export enum OCPPAction {
  // Charge Point to Central System
  CallResult = "CallResult",

  RemoteStartTransaction = "RemoteStartTransaction",
  RemoteStopTransaction = "RemoteStopTransaction",
  StartTransaction = "StartTransaction",
  StopTransaction = "StopTransaction",
  GetDiagnostics = "GetDiagnostics",
  TriggerMessage = "TriggerMessage",
  StatusNotification = "StatusNotification",
  MeterValues = "MeterValues",
  BootNotification = "BootNotification",
  Heartbeat = "Heartbeat",
  Authorize = "Authorize",
  Reset = "Reset",
  GetConfiguration = "GetConfiguration",
  ChangeConfiguration = "ChangeConfiguration",
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
