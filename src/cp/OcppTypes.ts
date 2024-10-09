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
