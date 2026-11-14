// "Mute" charger for the dev spike test: never answers a CALL the central
// system sends (ChangeConfiguration, TriggerMessage, anything else). The
// station keeps sending its own CALLs (BootNotification, StatusNotification,
// Heartbeat) as usual. This is the firmware the 2026-11-05 incident points at:
// the CS's post-connect ChangeConfiguration times out on these chargers.
//
// Loaded into every daemon with `--behavior <this file> --allow-behavior-code`;
// run.ts selects it per charge point (`behaviors: ["loadtest-mute"]`), the
// healthy chargers get `behaviors: []`.
import type {
  Behavior,
  CallBehavior,
} from "@ocpp-cp-simulator/contracts/behavior";

/** Every CS->CP action of OCPP 1.6J, core + security whitepaper. */
const CSMS_ACTIONS = [
  "CancelReservation",
  "CertificateSigned",
  "ChangeAvailability",
  "ChangeConfiguration",
  "ClearCache",
  "ClearChargingProfile",
  "DataTransfer",
  "DeleteCertificate",
  "ExtendedTriggerMessage",
  "GetCompositeSchedule",
  "GetConfiguration",
  "GetDiagnostics",
  "GetInstalledCertificateIds",
  "GetLocalListVersion",
  "GetLog",
  "InstallCertificate",
  "RemoteStartTransaction",
  "RemoteStopTransaction",
  "ReserveNow",
  "Reset",
  "SendLocalList",
  "SetChargingProfile",
  "SignedUpdateFirmware",
  "TriggerMessage",
  "UnlockConnector",
  "UpdateFirmware",
];

const silent: CallBehavior = {
  mode: "replace",
  // A second CALL of the same action while one is being decided: silent too.
  onBusy: { noResponse: true },
  handle: () => ({ noResponse: true }),
};

const onCall: Record<string, CallBehavior> = Object.fromEntries(
  CSMS_ACTIONS.map((action) => [action, silent]),
);

const loadtestMute: Behavior = {
  api: 1,
  id: "loadtest-mute",
  requires: ["ocpp1.6"],
  onCall,
};
export default loadtestMute;
