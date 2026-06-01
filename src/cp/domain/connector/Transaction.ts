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

export interface Transaction {
  id: number | null;
  connectorId: number;
  tagId: string;
  meterStart: number;
  meterStop: number | null;
  startTime: Date;
  stopTime: Date | null;
  meterSent: boolean;
  /** Reservation that this transaction consumes, set when the transaction
   *  was started against a connector already in the Reserved state (§5.13).
   *  Carried into StartTransaction.req so CSMS can close out the
   *  reservation. */
  reservationId?: number;
  /** Reason chosen for the StopTransaction.req payload. Defaults to `Local`
   *  when not explicitly assigned. */
  stopReason?: StopTransactionReason;
  batteryCapacityKwh?: number; // EV battery capacity in kWh
  initialSoc?: number; // Initial State of Charge percentage (0-100)
}
