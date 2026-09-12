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

const TRANSACTION_EVENT_TRIGGER_REASON_VALUES = [
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

/** Kept as names for the two lifecycle ends; both are the full enum since #335. */
export type TransactionStartTriggerReason = TransactionEventTriggerReason;
export type TransactionStopTriggerReason = TransactionEventTriggerReason;

const TRANSACTION_CHARGING_STATE_VALUES = [
  "Charging",
  "EVConnected",
  "SuspendedEV",
  "SuspendedEVSE",
  "Idle",
] as const;

/** OCPP 2.0.1 TransactionEvent.req `transactionInfo.chargingState` (§2.11). */
export type TransactionChargingState =
  (typeof TRANSACTION_CHARGING_STATE_VALUES)[number];

const STOP_TRANSACTION_REASON_VALUES = [
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

const TRANSACTION_STOPPED_REASON_VALUES = [
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

/**
 * The vocabularies as readonly tuples (for `z.enum`) and as sets (for the
 * JSON-Lines parser). One definition each — the command surfaces derive
 * theirs from here rather than restating a subset (#316's lesson).
 */
export const TRANSACTION_EVENT_TRIGGER_REASONS =
  TRANSACTION_EVENT_TRIGGER_REASON_VALUES;
export const TRANSACTION_CHARGING_STATES = TRANSACTION_CHARGING_STATE_VALUES;
export const STOP_TRANSACTION_REASONS = STOP_TRANSACTION_REASON_VALUES;
export const TRANSACTION_STOPPED_REASONS = TRANSACTION_STOPPED_REASON_VALUES;
/** Every value `stop_transaction { reason }` accepts: the 1.6 and the 2.0.1
 *  vocabularies, de-duplicated (eight names are spelled identically). */
export const STOP_REASONS = [
  ...new Set<string>([
    ...STOP_TRANSACTION_REASON_VALUES,
    ...TRANSACTION_STOPPED_REASON_VALUES,
  ]),
] as unknown as readonly [StopReason, ...StopReason[]];
export type StopReason = StopTransactionReason | TransactionStoppedReason;

const STOP_TRANSACTION_REASON_SET: ReadonlySet<string> = new Set(
  STOP_TRANSACTION_REASON_VALUES,
);
const TRANSACTION_STOPPED_REASON_SET: ReadonlySet<string> = new Set(
  TRANSACTION_STOPPED_REASON_VALUES,
);

/**
 * Split a `stop_transaction { reason }` into what each encoder reads (#335).
 * A 1.6 name sets `stopReason` (and, when 2.0.1 spells it the same, the
 * explicit `stoppedReason` too). A 2.0.1-only name — `SOCLimitReached`,
 * `GroundFault`, … — sets `stoppedReason` and falls back to `Other` for a
 * 1.6 StopTransaction.req, which has no closer value.
 */
export function splitStopReason(reason: StopReason | undefined): {
  stopReason?: StopTransactionReason;
  stoppedReason?: TransactionStoppedReason;
} {
  if (reason === undefined) return {};
  const is16 = STOP_TRANSACTION_REASON_SET.has(reason);
  const is201 = TRANSACTION_STOPPED_REASON_SET.has(reason);
  return {
    stopReason: is16 ? (reason as StopTransactionReason) : "Other",
    stoppedReason: is201 ? (reason as TransactionStoppedReason) : undefined,
  };
}

/** `start_transaction` options a control-plane caller may name (#335). */
export interface StartTransactionCommandOptions {
  triggerReason?: TransactionEventTriggerReason;
  chargingState?: TransactionChargingState;
}

/** `stop_transaction` options a control-plane caller may name (#335). */
export interface StopTransactionCommandOptions {
  reason?: StopReason;
  triggerReason?: TransactionEventTriggerReason;
}

/**
 * A driven OCPP 2.0.1 TransactionEvent(Updated) (#335). `triggerReason` is
 * the caller's; `chargingState` is optional and, when given, becomes the
 * state the next status-driven Updated event is de-duplicated against.
 * `meterValues: true` attaches the connector's current sampled values with
 * `context` (default `Sample.Periodic`), which is how 2.0.1 carries
 * in-transaction metering.
 */
export interface TransactionUpdateOptions {
  triggerReason: TransactionEventTriggerReason;
  chargingState?: TransactionChargingState;
  meterValues?: boolean;
  context?: MeterReadingContext;
}

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

export interface Transaction {
  id: number | null;
  connectorId: number;
  tagId: string;
  meterStart: number;
  meterStop: number | null;
  startTime: Date;
  stopTime: Date | null;
  meterSent: boolean;
  /** CP-minted transaction id for OCPP 2.x TransactionEvent (a string/UUID). OCPP 1.6 instead uses
   *  the numeric, CSMS-assigned `id` above. Persisted with the transaction (transaction_json) so the
   *  Started/Ended pairing survives a daemon restart. */
  cpTransactionId?: string;
  /** Next OCPP 2.x TransactionEvent seqNo to emit for THIS transaction (per-transaction counter,
   *  starts at 0; OCPP 2.0.1 SHOULD reset seqNo to 0 when a transaction starts). Persisted with the
   *  transaction so the sequence continues correctly across a daemon restart. OCPP 1.6 does not use this. */
  cpNextSeqNo?: number;
  /** Last OCPP 2.x TransactionEvent.transactionInfo.chargingState emitted for
   *  this transaction. Used to suppress duplicate Updated events when
   *  StatusNotification writes repeat the same Charging/Suspended state. */
  cpLastTransactionEventChargingState?: TransactionChargingState;
  /** Reservation that this transaction consumes, set when the transaction
   *  was started against a connector already in the Reserved state (§5.13).
   *  Carried into StartTransaction.req so CSMS can close out the
   *  reservation. */
  reservationId?: number;
  /** CSMS RequestStartTransaction remoteStartId carried into OCPP 2.x
   *  TransactionEvent.transactionInfo.remoteStartId. */
  remoteStartId?: number;
  /** OCPP 2.x TransactionEvent triggerReason for the Started event. If absent,
   *  the encoder defaults to the local Authorized path. */
  startTriggerReason?: TransactionStartTriggerReason;
  /** OCPP 2.x TransactionEvent chargingState for the Started event (#335).
   *  If absent the encoder sends `Charging`, the historical value. */
  startChargingState?: TransactionChargingState;
  /** OCPP 2.x TransactionEvent triggerReason for the Ended event. If absent,
   *  the encoder defaults to the local StopAuthorized path. */
  stopTriggerReason?: TransactionStopTriggerReason;
  /** Reason chosen for the StopTransaction.req payload. Defaults to `Local`
   *  when not explicitly assigned. */
  stopReason?: StopTransactionReason;
  /** OCPP 2.x TransactionEvent stoppedReason named explicitly by the stop
   *  (#335). When absent the encoder maps `stopReason` instead. */
  stoppedReason?: TransactionStoppedReason;
  batteryCapacityKwh?: number; // EV battery capacity in kWh
  initialSoc?: number; // Initial State of Charge percentage (0-100)
}
