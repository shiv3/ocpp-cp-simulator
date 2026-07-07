// Domain-facing outbound seam. Delegates to the version-specific message
// handler; ordering, boot-gate, and version-encoding will migrate here in
// later 0b increments.
import type { IChargePointMessageHandler } from "../../infrastructure/transport/IChargePointMessageHandler";
import type { TransactionLifecycleEvent } from "./TransactionLifecycleEvent";

export class Outbox implements IChargePointMessageHandler {
  constructor(private readonly handler: IChargePointMessageHandler) {}

  sendBootNotification(
    bootPayload: Parameters<
      IChargePointMessageHandler["sendBootNotification"]
    >[0],
  ): ReturnType<IChargePointMessageHandler["sendBootNotification"]> {
    return this.handler.sendBootNotification(bootPayload);
  }

  sendHeartbeat(): ReturnType<IChargePointMessageHandler["sendHeartbeat"]> {
    return this.handler.sendHeartbeat();
  }

  sendStatusNotification(
    connectorId: Parameters<
      IChargePointMessageHandler["sendStatusNotification"]
    >[0],
    status: Parameters<IChargePointMessageHandler["sendStatusNotification"]>[1],
    opts?: Parameters<IChargePointMessageHandler["sendStatusNotification"]>[2],
  ): ReturnType<IChargePointMessageHandler["sendStatusNotification"]> {
    return this.handler.sendStatusNotification(connectorId, status, opts);
  }

  authorize(
    tagId: Parameters<IChargePointMessageHandler["authorize"]>[0],
  ): ReturnType<IChargePointMessageHandler["authorize"]> {
    return this.handler.authorize(tagId);
  }

  sendTransactionEvent(
    event: TransactionLifecycleEvent,
  ): ReturnType<IChargePointMessageHandler["sendTransactionEvent"]> {
    return this.handler.sendTransactionEvent(event);
  }

  sendMeterValue(
    transactionId: Parameters<IChargePointMessageHandler["sendMeterValue"]>[0],
    connectorId: Parameters<IChargePointMessageHandler["sendMeterValue"]>[1],
    context?: Parameters<IChargePointMessageHandler["sendMeterValue"]>[2],
  ): ReturnType<IChargePointMessageHandler["sendMeterValue"]> {
    return this.handler.sendMeterValue(transactionId, connectorId, context);
  }

  sendDataTransfer(
    vendorId: Parameters<IChargePointMessageHandler["sendDataTransfer"]>[0],
    messageId: Parameters<IChargePointMessageHandler["sendDataTransfer"]>[1],
    data?: Parameters<IChargePointMessageHandler["sendDataTransfer"]>[2],
  ): ReturnType<IChargePointMessageHandler["sendDataTransfer"]> {
    return this.handler.sendDataTransfer(vendorId, messageId, data);
  }

  sendSecurityEventNotification(
    type: Parameters<
      IChargePointMessageHandler["sendSecurityEventNotification"]
    >[0],
    techInfo?: Parameters<
      IChargePointMessageHandler["sendSecurityEventNotification"]
    >[1],
  ): ReturnType<IChargePointMessageHandler["sendSecurityEventNotification"]> {
    return this.handler.sendSecurityEventNotification(type, techInfo);
  }

  sendSignCertificate(
    csr?: Parameters<IChargePointMessageHandler["sendSignCertificate"]>[0],
  ): ReturnType<IChargePointMessageHandler["sendSignCertificate"]> {
    return this.handler.sendSignCertificate(csr);
  }

  sendDiagnosticsStatusNotification(
    status: Parameters<
      IChargePointMessageHandler["sendDiagnosticsStatusNotification"]
    >[0],
  ): ReturnType<
    IChargePointMessageHandler["sendDiagnosticsStatusNotification"]
  > {
    return this.handler.sendDiagnosticsStatusNotification(status);
  }

  sendFirmwareStatusNotification(
    status: Parameters<
      IChargePointMessageHandler["sendFirmwareStatusNotification"]
    >[0],
  ): ReturnType<IChargePointMessageHandler["sendFirmwareStatusNotification"]> {
    return this.handler.sendFirmwareStatusNotification(status);
  }

  sendLogStatusNotification(
    status: Parameters<
      IChargePointMessageHandler["sendLogStatusNotification"]
    >[0],
    requestId?: Parameters<
      IChargePointMessageHandler["sendLogStatusNotification"]
    >[1],
  ): ReturnType<IChargePointMessageHandler["sendLogStatusNotification"]> {
    return this.handler.sendLogStatusNotification(status, requestId);
  }

  sendSignedFirmwareStatusNotification(
    status: Parameters<
      IChargePointMessageHandler["sendSignedFirmwareStatusNotification"]
    >[0],
    requestId?: Parameters<
      IChargePointMessageHandler["sendSignedFirmwareStatusNotification"]
    >[1],
  ): ReturnType<
    IChargePointMessageHandler["sendSignedFirmwareStatusNotification"]
  > {
    return this.handler.sendSignedFirmwareStatusNotification(status, requestId);
  }

  setBootStatus(
    status: Parameters<IChargePointMessageHandler["setBootStatus"]>[0],
  ): ReturnType<IChargePointMessageHandler["setBootStatus"]> {
    return this.handler.setBootStatus(status);
  }

  getDataTransferHandler(): ReturnType<
    IChargePointMessageHandler["getDataTransferHandler"]
  > {
    return this.handler.getDataTransferHandler();
  }

  onWebSocketClosed(): ReturnType<
    IChargePointMessageHandler["onWebSocketClosed"]
  > {
    return this.handler.onWebSocketClosed();
  }

  flushPendingQueue(): ReturnType<
    IChargePointMessageHandler["flushPendingQueue"]
  > {
    return this.handler.flushPendingQueue();
  }
}
