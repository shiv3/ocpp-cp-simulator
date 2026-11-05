// Connector status values (OCPP 1.6 StatusNotification `status`), as the
// control plane reports them on the wire and accepts them in
// `update_connector_status`.

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
