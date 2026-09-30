import type {
  DataTransferData,
  DataTransferResult,
} from "../../domain/types/DataTransfer";
import type {
  OcppCallOutcome,
  OcppCallRequest,
} from "../../domain/types/OcppCall";
import type {
  DiagnosticsStatus,
  FirmwareStatus,
  UploadLogStatus,
} from "../../domain/types/FirmwareLogStatus";
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
    data?: DataTransferData,
  ): Promise<DataTransferResult>;
  /**
   * Expert OCPP call (#389): send `request.action` with the payload as given.
   * The caller (`ChargePoint.sendOcppCall`) has already checked the action
   * against the version's catalog. Resolves with the CALLRESULT or CALLERROR;
   * rejects with `OcppCallRejectedError` before writing anything (invalid
   * payload without `skipValidation`, boot gate, SOAP) and with
   * `OcppCallNoAnswerError` on a drop, a close or after
   * {@link OCPP_CALL_RESPONSE_TIMEOUT_MS}.
   */
  sendOcppCall(request: OcppCallRequest): Promise<OcppCallOutcome>;
  sendSecurityEventNotification(type: string, techInfo?: string): void;
  sendSignCertificate(csr?: string): Promise<void>;
  sendDiagnosticsStatusNotification(status: DiagnosticsStatus): void;
  /** FirmwareStatusNotification.req. `requestId` is carried on 2.0.1 (from
   *  the UpdateFirmware that was acked when omitted); 1.6's request has no
   *  such field and drops it (#345). */
  sendFirmwareStatusNotification(
    status: FirmwareStatus,
    requestId?: number,
  ): void;
  /** LogStatusNotification.req (1.6 Security Whitepaper / 2.0.1 N01).
   *  `requestId` defaults to the GetLog that was acked on 2.0.1 (#345). */
  sendLogStatusNotification(status: UploadLogStatus, requestId?: number): void;
  sendSignedFirmwareStatusNotification(
    status: FirmwareStatus,
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
