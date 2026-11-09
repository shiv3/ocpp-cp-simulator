import type { OperatingPoint } from "../connector/OperatingPoint";
import type { Transaction } from "../connector/Transaction";

export type TransactionPhase = "started" | "ended";

export interface TransactionLifecycleEvent {
  readonly phase: TransactionPhase;
  readonly transaction: Transaction;
  readonly connectorId: number;
  /** `ended` only: the operating point resolved at the stop instant, before
   *  the status write that leaves `Charging` (#607, #327). */
  readonly endPoint?: OperatingPoint;
}
