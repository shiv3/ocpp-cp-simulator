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

export type TransactionStartTriggerReason = "Authorized" | "RemoteStart";

export type TransactionStopTriggerReason =
  | "EnergyLimitReached"
  | "RemoteStop"
  | "ResetCommand"
  | "StopAuthorized";

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
  /** OCPP 2.x TransactionEvent triggerReason for the Ended event. If absent,
   *  the encoder defaults to the local StopAuthorized path. */
  stopTriggerReason?: TransactionStopTriggerReason;
  /** Reason chosen for the StopTransaction.req payload. Defaults to `Local`
   *  when not explicitly assigned. */
  stopReason?: StopTransactionReason;
  batteryCapacityKwh?: number; // EV battery capacity in kWh
  initialSoc?: number; // Initial State of Charge percentage (0-100)
}
