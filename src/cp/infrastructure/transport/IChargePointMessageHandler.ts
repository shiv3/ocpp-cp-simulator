import type {
  BootNotification,
  ChargePointErrorCode,
  OCPPStatus,
} from "../../domain/types/OcppTypes";
import type { Transaction } from "../../domain/connector/Transaction";
import type { ReadingContext } from "../../domain/connector/MeterValueBuilder";
import type { DataTransferHandler } from "./handlers";

export interface IChargePointMessageHandler {
  sendBootNotification(bootPayload: BootNotification): void;
  sendHeartbeat(): void;
  sendStatusNotification(
    connectorId: number,
    status: OCPPStatus,
    opts?: {
      errorCode?: ChargePointErrorCode;
      info?: string;
      vendorErrorCode?: string;
      vendorId?: string;
      timestamp?: Date;
    },
  ): void;
  authorize(tagId: string): void;
  startTransaction(transaction: Transaction, connectorId: number): void;
  stopTransaction(transaction: Transaction, connectorId: number): void;
  sendMeterValue(
    transactionId: number | undefined,
    connectorId: number,
    context?: ReadingContext,
  ): void;
  sendDataTransfer(vendorId: string, messageId: string, data?: string): void;
  sendDiagnosticsStatusNotification(status: string): void;
  sendFirmwareStatusNotification(status: string): void;
  setBootStatus(
    status:
      | { status: "Idle" }
      | { status: "Accepted" }
      | { status: "Pending" }
      | { status: "Rejected"; retryAfter: Date },
  ): void;
  getDataTransferHandler(): DataTransferHandler;
  onWebSocketClosed(): void;
  flushPendingQueue(): void;
}
