// The transaction vocabularies the control plane speaks: the OCPP 2.0.1
// TransactionEvent enums, the 1.6 StopTransaction reasons and the meter reading
// contexts. Defined here so the method schemas (`methods.ts`) need nothing from
// the charge point; `cp/domain/connector/Transaction.ts` re-exports them.

/**
 * StopTransaction.req `reason` enumeration (OCPP 1.6 §7.36).
 *
 * Spec note: `Local` may be omitted from the request because it's the
 * default. Any other value MUST be set when the stop cause is known.
 */
export type StopTransactionReason =
  | "DeAuthorized"
  | "EmergencyStop"
  | "EVDisconnected"
  | "HardReset"
  | "Local"
  | "Other"
  | "PowerLoss"
  | "Reboot"
  | "Remote"
  | "SoftReset"
  | "UnlockCommand";

export const TRANSACTION_EVENT_TRIGGER_REASON_VALUES = [
  "Authorized",
  "CablePluggedIn",
  "ChargingRateChanged",
  "ChargingStateChanged",
  "Deauthorized",
  "EnergyLimitReached",
  "EVCommunicationLost",
  "EVConnectTimeout",
  "MeterValueClock",
  "MeterValuePeriodic",
  "TimeLimitReached",
  "Trigger",
  "UnlockCommand",
  "StopAuthorized",
  "EVDeparted",
  "EVDetected",
  "RemoteStop",
  "RemoteStart",
  "AbnormalCondition",
  "SignedDataReceived",
  "ResetCommand",
] as const;

/**
 * OCPP 2.0.1 TransactionEvent.req `triggerReason` (TriggerReasonEnumType,
 * §2.50). The full vocabulary is accepted on every event so a driven station
 * can produce the events a CSMS conformance case is named for (#335); the
 * simulator itself only ever chooses a handful of them.
 */
export type TransactionEventTriggerReason =
  (typeof TRANSACTION_EVENT_TRIGGER_REASON_VALUES)[number];

export const TRANSACTION_CHARGING_STATE_VALUES = [
  "Charging",
  "EVConnected",
  "SuspendedEV",
  "SuspendedEVSE",
  "Idle",
] as const;

/** OCPP 2.0.1 TransactionEvent.req `transactionInfo.chargingState` (§2.11). */
export type TransactionChargingState =
  (typeof TRANSACTION_CHARGING_STATE_VALUES)[number];

export const STOP_TRANSACTION_REASON_VALUES = [
  "DeAuthorized",
  "EmergencyStop",
  "EVDisconnected",
  "HardReset",
  "Local",
  "Other",
  "PowerLoss",
  "Reboot",
  "Remote",
  "SoftReset",
  "UnlockCommand",
] as const satisfies readonly StopTransactionReason[];

export const TRANSACTION_STOPPED_REASON_VALUES = [
  "DeAuthorized",
  "EmergencyStop",
  "EnergyLimitReached",
  "EVDisconnected",
  "GroundFault",
  "ImmediateReset",
  "Local",
  "LocalOutOfCredit",
  "MasterPass",
  "Other",
  "OvercurrentFault",
  "PowerLoss",
  "PowerQuality",
  "Reboot",
  "Remote",
  "SOCLimitReached",
  "StoppedByEV",
  "TimeLimitReached",
  "Timeout",
] as const;

/**
 * OCPP 2.0.1 TransactionEvent.req `transactionInfo.stoppedReason`
 * (ReasonEnumType, §2.40). Wider than the 1.6 `StopTransactionReason`
 * above; when a stop names one of these explicitly it is sent verbatim,
 * otherwise the encoder maps the 1.6 reason (see `toV201StoppedReason`).
 */
export type TransactionStoppedReason =
  (typeof TRANSACTION_STOPPED_REASON_VALUES)[number];

/** Every value `stop_transaction { reason }` accepts: the 1.6 and the 2.0.1
 *  vocabularies, de-duplicated (eight names are spelled identically). */
export const STOP_REASONS = [
  ...new Set<string>([
    ...STOP_TRANSACTION_REASON_VALUES,
    ...TRANSACTION_STOPPED_REASON_VALUES,
  ]),
] as unknown as readonly [StopReason, ...StopReason[]];
export type StopReason = StopTransactionReason | TransactionStoppedReason;

export const METER_READING_CONTEXTS = [
  "Sample.Periodic",
  "Sample.Clock",
  "Transaction.Begin",
  "Transaction.End",
  "Trigger",
  "Interruption.Begin",
  "Interruption.End",
  "Other",
] as const;
/** Same vocabulary as `ReadingContext` in MeterValueBuilder (1.6 §7.35 and
 *  2.0.1 ReadingContextEnumType spell it identically). */
export type MeterReadingContext = (typeof METER_READING_CONTEXTS)[number];

/**
 * OCPP 2.0.1 `IdTokenEnumType` (Part 2 §3.43), the `type` of an `IdToken` in
 * Authorize and TransactionEvent. 2.1 keeps these values. Certificate based
 * authorization (`iso15118CertificateHashData`) is a separate path (#599).
 */
export const ID_TOKEN_TYPE_VALUES = [
  "Central",
  "eMAID",
  "ISO14443",
  "ISO15693",
  "KeyCode",
  "Local",
  "MacAddress",
  "NoAuthorization",
] as const;

export type IdTokenTypeName = (typeof ID_TOKEN_TYPE_VALUES)[number];

/** The `IdToken.type` sent when a caller names none. */
export const DEFAULT_ID_TOKEN_TYPE: IdTokenTypeName = "ISO14443";
