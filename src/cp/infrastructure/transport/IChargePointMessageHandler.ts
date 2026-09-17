import type { DataTransferResult } from "../../domain/types/DataTransfer";
import type {
  BootNotification,
  ChargePointErrorCode,
  OCPPStatus,
} from "../../domain/types/OcppTypes";
import type { ReadingContext } from "../../domain/connector/MeterValueBuilder";
import type { TransactionLifecycleEvent } from "../../domain/transport/TransactionLifecycleEvent";
import type { TransactionUpdateOptions } from "../../domain/connector/Transaction";
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
  /** A driven OCPP 2.x TransactionEvent(Updated) (#335). 1.6 handlers have
   *  no such message and log a warning instead of sending anything. */
  sendTransactionUpdate(
    connectorId: number,
    options: TransactionUpdateOptions,
  ): void;
  sendMeterValue(
    transactionId: number | undefined,
    connectorId: number,
    context?: ReadingContext,
  ): void;
  /**
   * Station-initiated DataTransfer.req (#348). Resolves with the CSMS's
   * answer, rejects on CALLERROR, on a drop (boot gate, socket closed) or
   * after {@link DATA_TRANSFER_RESPONSE_TIMEOUT_MS}. `data` is sent as-is on
   * 2.0.1 and as a string on 1.6 (a non-string is JSON-encoded).
   */
  sendDataTransfer(
    vendorId: string,
    messageId?: string,
    data?: unknown,
  ): Promise<DataTransferResult>;
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
