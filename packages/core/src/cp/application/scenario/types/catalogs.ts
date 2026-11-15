/** Incoming CSMS→CP calls a csmsCallTrigger node can wait for. */
export const CSMS_CALL_TRIGGER_ACTIONS = [
  "Reset",
  "GetConfiguration",
  "ChangeConfiguration",
  "ClearCache",
  "GetLocalListVersion",
  "SendLocalList",
  "TriggerMessage",
  "SetChargingProfile",
  "ClearChargingProfile",
  "GetCompositeSchedule",
  "UpdateFirmware",
  "GetDiagnostics",
  "ReserveNow",
  "CancelReservation",
  "UnlockConnector",
  "RemoteStartTransaction",
  "RemoteStopTransaction",
  "DataTransfer",
  "ChangeAvailability",
] as const;

/** Actions a responseOverride node may target: their CALLRESULT payload
 *  is exactly `{ status }`, so a canned status is schema-valid. */
export const RESPONSE_OVERRIDE_ACTIONS = [
  "RemoteStartTransaction",
  "RemoteStopTransaction",
  "TriggerMessage",
  "ReserveNow",
  "CancelReservation",
  "SendLocalList",
  "ChangeConfiguration",
  "ClearCache",
  "SetChargingProfile",
  "ClearChargingProfile",
  "ChangeAvailability",
] as const;

/** Statuses valid for each responseOverride action's `{ status }`
 *  CALLRESULT, per this repo's generated OCPP 1.6 response types
 *  (packages/ocpp/src/v16/types/*-response.ts). Keeps editor UI from offering
 *  schema-invalid action/status combinations. */
export const RESPONSE_OVERRIDE_STATUSES: Record<
  (typeof RESPONSE_OVERRIDE_ACTIONS)[number],
  readonly string[]
> = {
  RemoteStartTransaction: ["Accepted", "Rejected"],
  RemoteStopTransaction: ["Accepted", "Rejected"],
  TriggerMessage: ["Accepted", "Rejected", "NotImplemented"],
  ReserveNow: ["Accepted", "Faulted", "Occupied", "Rejected", "Unavailable"],
  CancelReservation: ["Accepted", "Rejected"],
  SendLocalList: ["Accepted", "Failed", "NotSupported", "VersionMismatch"],
  ChangeConfiguration: [
    "Accepted",
    "Rejected",
    "RebootRequired",
    "NotSupported",
  ],
  ClearCache: ["Accepted", "Rejected"],
  SetChargingProfile: ["Accepted", "Rejected", "NotSupported"],
  ClearChargingProfile: ["Accepted", "Unknown"],
  ChangeAvailability: ["Accepted", "Rejected", "Scheduled"],
};

/** Actions a inboundPolicy node may target. Uses the full set of
 *  inbound CSMS→CP actions (like csmsCallTrigger), since policies can
 *  apply to any incoming call — not just those with `{ status }` responses. */
export const INBOUND_POLICY_ACTIONS = CSMS_CALL_TRIGGER_ACTIONS;

/** Valid OCPP 1.6 error codes for inboundPolicy callerror mode. */
export const INBOUND_POLICY_ERROR_CODES = [
  "NotImplemented",
  "NotSupported",
  "InternalError",
  "ProtocolError",
  "SecurityError",
  "FormationViolation",
  "PropertyConstraintViolation",
  "OccurenceConstraintViolation",
  "TypeConstraintViolation",
  "GenericError",
] as const;

/** Presets for certQuirks node; currently "octt" encodes legacy OCTT
 *  strictness (RSA CSR, CRLF PEM, RSASSA-PKCS1-v1_5 only, hide CpoName). */
export const CERT_QUIRKS_PRESETS = ["octt"] as const;

/** The OCTT preset expansion: legacy SHA256withRSA-only acceptance
 *  (reject RSA-PSS), RSA CSR, CRLF PEM, no CpoName reference.
 *  See steve-community/steve#2093. */
export const OCTT_PRESET_QUIRKS = {
  csrKeyAlgorithm: "RSA",
  csrPemLineEndings: "crlf",
  requiredCertificateSignatureAlgorithms: ["RSASSA-PKCS1-v1_5"],
  hiddenConfigurationKeys: ["CpoName"],
} as const;

/** Valid certificate signature algorithm names for certQuirks validation. */
export const CERT_SIGNATURE_ALGORITHMS = [
  "ECDSA",
  "RSASSA-PKCS1-v1_5",
  "RSA-PSS",
] as const;
