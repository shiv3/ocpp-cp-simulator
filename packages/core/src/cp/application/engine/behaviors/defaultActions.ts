/**
 * The CSMS actions a default behavior answers, the same on every OCPP
 * version: `mode: "extend"` is possible for these only. A test checks the
 * list against what the engine registers; keep it next to `index.ts`.
 */
export const DEFAULT_ACTIONS: ReadonlySet<string> = new Set([
  "UpdateFirmware",
  "SignedUpdateFirmware",
  "GetDiagnostics",
  "GetLog",
  "Reset",
  "ChangeAvailability",
  "ReserveNow",
  "CancelReservation",
  "UnlockConnector",
  "RemoteStartTransaction",
  "RemoteStopTransaction",
  "RequestStartTransaction",
  "RequestStopTransaction",
]);
