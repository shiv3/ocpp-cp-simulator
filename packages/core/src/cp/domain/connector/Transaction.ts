import type { MeterSampleOverrides } from "./MeterValueBuilder";
import {
  METER_READING_CONTEXTS,
  STOP_REASONS,
  STOP_TRANSACTION_REASON_VALUES,
  TRANSACTION_CHARGING_STATE_VALUES,
  TRANSACTION_EVENT_TRIGGER_REASON_VALUES,
  TRANSACTION_STOPPED_REASON_VALUES,
  type MeterReadingContext,
  type StopReason,
  type StopTransactionReason,
  type TransactionChargingState,
  type TransactionEventTriggerReason,
  type TransactionStoppedReason,
} from "@ocpp-cp-sim/contracts/transactionVocabulary";

// The vocabularies are defined in `packages/contracts/src` (#578); these re-exports keep
// the old import path working.
export {
  METER_READING_CONTEXTS,
  STOP_REASONS,
  type MeterReadingContext,
  type StopReason,
  type StopTransactionReason,
  type TransactionChargingState,
  type TransactionEventTriggerReason,
  type TransactionStoppedReason,
};

/** Kept as names for the two lifecycle ends; both are the full enum since #335. */
export type TransactionStartTriggerReason = TransactionEventTriggerReason;
export type TransactionStopTriggerReason = TransactionEventTriggerReason;

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

const STOP_TRANSACTION_REASON_SET: ReadonlySet<string> = new Set(
  STOP_TRANSACTION_REASON_VALUES,
);
const TRANSACTION_STOPPED_REASON_SET: ReadonlySet<string> = new Set(
  TRANSACTION_STOPPED_REASON_VALUES,
);

/** OCPP 1.6: whether `transaction` is the running one a StartTransaction.req
 *  with this `idTag` and `timestamp` started. A resent or replayed request
 *  carries the same payload, so its answer still finds it (#527). */
export function isRunningTransactionStartedBy(
  transaction: Transaction | null | undefined,
  request: { idTag: string; timestamp: string },
): transaction is Transaction {
  return (
    !!transaction &&
    transaction.stopTime === null &&
    transaction.tagId === request.idTag &&
    transaction.startTime.toISOString() === request.timestamp
  );
}

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

/**
 * The 2.0.1 `stoppedReason` for a 1.6-shaped `stopReason`, when the stop
 * named no 2.0.1 reason of its own. 2.0.1 has no reset or unlock reasons of
 * the 1.6 kind, so `HardReset` / `SoftReset` / `UnlockCommand` map onto the
 * closest ones.
 */
export function toV201StoppedReason(
  reason: StopTransactionReason | undefined,
): TransactionStoppedReason {
  switch (reason) {
    case undefined:
      return "Local";
    case "DeAuthorized":
    case "EmergencyStop":
    case "EVDisconnected":
    case "Local":
    case "Other":
    case "PowerLoss":
    case "Reboot":
    case "Remote":
      return reason;
    case "HardReset":
      return "ImmediateReset";
    case "SoftReset":
      return "Reboot";
    case "UnlockCommand":
      return "Other";
    default:
      return "Other";
  }
}

/** The 2.x Ended event's `stoppedReason`: the one the stop named, else the
 *  1.6-shaped `stopReason` mapped. */
export function endedStoppedReason(
  transaction: Pick<Transaction, "stoppedReason" | "stopReason">,
): TransactionStoppedReason {
  return (
    transaction.stoppedReason ?? toV201StoppedReason(transaction.stopReason)
  );
}

/** The 2.x Ended event's `triggerReason`; the local StopAuthorized path when
 *  the stop named none. */
export function endedTriggerReason(
  transaction: Pick<Transaction, "stopTriggerReason">,
): TransactionStopTriggerReason {
  return transaction.stopTriggerReason ?? "StopAuthorized";
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
 * in-transaction metering. `measurands` and `timestamp` replace
 * `MeterValuesSampledData` and "now" for a clock-aligned sample (#454); the
 * control plane does not expose them.
 */
export interface TransactionUpdateOptions extends MeterSampleOverrides {
  triggerReason: TransactionEventTriggerReason;
  chargingState?: TransactionChargingState;
  meterValues?: boolean;
  context?: MeterReadingContext;
  /**
   * With `meterValues`, send nothing when there is no sampled value to
   * attach, rather than an Updated event without `meterValue`: a scheduled
   * sample (#347) with nothing in it is not an event. Internal — the
   * control plane does not expose it.
   */
  skipWithoutMeterValue?: boolean;
}

export interface Transaction {
  /** CSMS-assigned (OCPP 1.x); `0` until StartTransaction.conf assigns it.
   *  No transaction is `connector.transaction === null`, never a null id. */
  id: number;
  /** OCPP 1.6: set when a CALLERROR answered this transaction's
   *  StartTransaction.req, until a StartTransaction.conf assigns `id`. Its
   *  `0` is then a placeholder the CSMS failed to process, not an id it
   *  issued: RemoteStopTransaction does not match it (#491, #527). */
  startCallError?: boolean;
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
  /** #315: the OCMF document signed for the begin reading when the
   *  transaction started (only while `SampledDataSignReadings` is on). 1.6
   *  has nowhere to send it at start, so it rides in StopTransaction's
   *  `transactionData` next to the end reading; signing it at start keeps
   *  the meter's page numbers in time order. Dropped when a transaction is
   *  restored after a restart: the key that signed it is gone. */
  signedBeginOcmf?: string;
  /** OCPP 2.x TransactionEvent triggerReason for the Ended event. If absent,
   *  the encoder defaults to the local StopAuthorized path. */
  stopTriggerReason?: TransactionStopTriggerReason;
  /** Reason chosen for the StopTransaction.req payload. Defaults to `Local`
   *  when not explicitly assigned. */
  stopReason?: StopTransactionReason;
  /** OCPP 2.x TransactionEvent stoppedReason named explicitly by the stop
   *  (#335). When absent the encoder maps `stopReason` instead. */
  stoppedReason?: TransactionStoppedReason;
  /** The id status the CSMS answered other than `Accepted` (StartTransaction
   *  .conf `idTagInfo`, 2.x TransactionEvent.conf `idTokenInfo`), recorded
   *  before the station stops on it (#447). */
  authorizationStatus?: string;
  /** 2.x: that status answered an `Updated` event, i.e. the CSMS withdrew
   *  the id mid-session rather than refusing the start (#447). */
  authorizationRejectedMidSession?: boolean;
  batteryCapacityKwh?: number; // EV battery capacity in kWh
  initialSoc?: number; // Initial State of Charge percentage (0-100)
}
