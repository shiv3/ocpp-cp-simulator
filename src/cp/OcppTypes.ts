export enum OCPPStatus {
  Available = "Available",
  Preparing = "Preparing",
  Charging = "Charging",
  SuspendedEVSE = "SuspendedEVSE",
  SuspendedEV = "SuspendedEV",
  Finishing = "Finishing",
  Reserved = "Reserved",
  Unavailable = "Unavailable",
  Faulted = "Faulted"
}

export enum OCPPAvailability  {
  Operative =  "Operative",
  Inoperative = "Inoperative",
}

export enum OCPPMessageType {
  CALL = 2,
  CALL_RESULT = 3,
  CALL_ERROR = 4,
}


export enum OCPPAction {
  // Charge Point to Central System
  CallResult = 'CallResult',

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
  Authorize = 'Authorize',
  Reset = 'Reset',
}

