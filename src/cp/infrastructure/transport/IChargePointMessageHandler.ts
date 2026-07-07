import type {
  BootNotification,
  ChargePointErrorCode,
  OCPPStatus,
} from "../../domain/types/OcppTypes";
import type { ReadingContext } from "../../domain/connector/MeterValueBuilder";
import type { TransactionLifecycleEvent } from "../../domain/transport/TransactionLifecycleEvent";
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
      suppressChargingStateTransactionEvent?: boolean;
    },
  ): void;
  authorize(tagId: string): void;
  sendTransactionEvent(event: TransactionLifecycleEvent): void;
  sendMeterValue(
    transactionId: number | undefined,
    connectorId: number,
    context?: ReadingContext,
  ): void;
  sendDataTransfer(vendorId: string, messageId?: string, data?: string): void;
  sendSecurityEventNotification(type: string, techInfo?: string): void;
  sendSignCertificate(csr?: string): Promise<void>;
  sendDiagnosticsStatusNotification(status: string): void;
  sendFirmwareStatusNotification(status: string): void;
  sendLogStatusNotification(status: string, requestId?: number): void;
  sendSignedFirmwareStatusNotification(
    status: string,
    requestId?: number,
  ): void;
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
