export enum OCPPStatus {
  Available = "Available",
  Preparing = "Preparing",
  Charging = "Charging",
  SuspendedEV = "SuspendedEV",
  SuspendedEVSE = "SuspendedEVSE",
  Finishing = "Finishing",
  Reserved = "Reserved",
  Unavailable = "Unavailable",
  Authorized = "authorized",
  Faulted = "faulted",
}


export const CONN_AVAILABLE = "Available";
export const CONN_CHARGING = "Charging";
export const CONN_UNAVAILABLE = "Unavailable";

export const AVAILABITY_OPERATIVE = "Operative";
export const AVAILABITY_INOPERATIVE = "Inoperative";

// Add other constants as needed

export enum OCPPMessageType {
  CALL = 2,
  CALL_RESULT = 3,
  CALL_ERROR = 4,
}


export enum OCPPAction {
  RemoteStartTransaction = 'RemoteStartTransaction',
  RemoteStopTransaction = 'RemoteStopTransaction',
  StartTransaction = 'StartTransaction',
  StopTransaction = 'StopTransaction',
  GetDiagnostics = 'GetDiagnostics',
  TriggerMessage = 'TriggerMessage',
  StatusNotification = 'StatusNotification',
  MeterValues = 'MeterValues',
  BootNotification = 'BootNotification',
  Heartbeat = 'Heartbeat',
}


export type OCPPStopTransactionRequest = {
  transactionId: number;
  meterStop: number;
  timestamp: string;
}

export type OCPPStopTransactionResponse = {
  idTagInfo: {
    status: string;
    expiryDate: string;
    parentIdTag: string;
  }
}

export type OCPPGetDiagnosticsRequest = {
  location: string;
  startTime: string;
  stopTime: string;
}

export type OCPPGetDiagnosticsResponse = {
  fileName: string;
  fileSize: number;
  status: string;
}

export enum MessageTrigger {
  BootNotification = 'BootNotification',
  DiagnosticsStatusNotification = 'DiagnosticsStatusNotification',
  FirmwareStatusNotification = 'FirmwareStatusNotification',
  StatusNotification = 'StatusNotification',
  MeterValues = 'MeterValues',
  Heartbeat = 'Heartbeat',
}

export type OCPPTriggerMessageRequest = {
  requestedMessage: MessageTrigger;
  connectorId: number;
}

export type OCPPTriggerMessageResponse = {
  status: string;
}

