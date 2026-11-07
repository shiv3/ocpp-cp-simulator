import type { Connector } from "../../../domain/connector/Connector";
import type { Transaction } from "../../../domain/connector/Transaction";

/**
 * Change fields of `transaction` through the engine: when it is the
 * connector's own transaction (the live view) the change is a
 * `transaction.patch` write. A transaction that is not attached to the
 * connector (a detached copy, a connector double) is updated directly.
 */
export function patchTransaction(
  chargePoint: { getConnector(id: number): Connector | undefined },
  connectorId: number,
  transaction: Transaction,
  fields: Partial<Record<keyof Transaction, unknown>>,
): void {
  const connector = chargePoint.getConnector(connectorId);
  if (
    connector &&
    connector.transaction === transaction &&
    typeof connector.patchTransaction === "function"
  ) {
    connector.patchTransaction(fields);
  } else {
    Object.assign(transaction, fields);
  }
}
