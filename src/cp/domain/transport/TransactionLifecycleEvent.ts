import type { Transaction } from "../connector/Transaction";

export type TransactionPhase = "started" | "ended";

export interface TransactionLifecycleEvent {
  readonly phase: TransactionPhase;
  readonly transaction: Transaction;
  readonly connectorId: number;
}
