// OCPPStatus → TransactionEvent chargingState, moved out of
// OCPPMessageHandlerV201 (#877).
import { OCPPStatus } from "../../../domain/types/OcppTypes";
import type { TransactionChargingState } from "../../../domain/connector/Transaction";

export function ocppStatusToTransactionChargingState(
  status: OCPPStatus,
): TransactionChargingState | null {
  switch (status) {
    case OCPPStatus.Charging:
      return "Charging";
    case OCPPStatus.SuspendedEV:
      return "SuspendedEV";
    case OCPPStatus.SuspendedEVSE:
      return "SuspendedEVSE";
    default:
      return null;
  }
}
