import { CallResultHandler, HandlerContext } from "../MessageHandlerRegistry";
import type {} from "../../../../../ocpp";
import type { AuthorizeRequestV16 } from "../../../../../ocpp";
import { OCPPStatus } from "../../../../domain/types/OcppTypes";
import { LogType } from "../../../../shared/Logger";

export class StartTransactionResultHandler implements CallResultHandler<StartTransactionResponseV16> {
  constructor(private connectorId: number) {}

  handle(payload: StartTransactionResponseV16, context: HandlerContext): void {
    const { transactionId, idTagInfo } = payload;
    const connector = context.chargePoint.getConnector(this.connectorId);

    if (idTagInfo.status === "Accepted") {
      if (connector) {
        connector.transactionId = transactionId;
        // #175: a scenario's own explicit `statusChange` node typically
        // drives Preparing -> Charging itself right after StartTransaction
        // is sent (scenario continuation is synchronous; this CALLRESULT
        // is a genuine round trip and consistently arrives after). Only
        // re-drive here — and emit a second StatusNotification.req — if
        // that hasn't already happened.
        if (connector.status !== OCPPStatus.Charging) {
          context.logger.info(
            `StartTransaction accepted for connector ${this.connectorId}, transitioning to Charging`,
            LogType.TRANSACTION,
          );
          context.chargePoint.updateConnectorStatus(
            this.connectorId,
            OCPPStatus.Charging,
          );
        } else {
          context.logger.info(
            `StartTransaction accepted for connector ${this.connectorId}; already Charging, skipping redundant StatusNotification`,
            LogType.TRANSACTION,
          );
        }
      }
    } else {
      // Issue #181: §4.8 StopTransactionOnInvalidId — a non-Accepted
      // idTagInfo on StartTransaction.conf either administratively stops
      // the transaction (DeAuthorized, default) or is logged and the
      // transaction keeps running, per the key's value.
      const status = idTagInfo.status;
      const stopOnInvalid =
        context.chargePoint.configuration.stopTransactionOnInvalidId();
      context.logger.warn(
        `StartTransaction not accepted (${status}) for connector ${this.connectorId}; StopTransactionOnInvalidId=${stopOnInvalid}`,
        LogType.TRANSACTION,
      );
      if (connector) {
        // Record the CSMS-assigned transactionId regardless of outcome —
        // §4.8 guarantees it's present even on rejection, and the
        // DeAuthorized StopTransaction.req below needs it to correlate.
        connector.transactionId = transactionId;
        if (stopOnInvalid) {
          context.chargePoint.stopTransaction(connector, "DeAuthorized");
        } else if (connector.status !== OCPPStatus.Charging) {
          // StopTransactionOnInvalidId=false: the CP doesn't stop on its
          // own initiative — the transaction proceeds as if accepted.
          context.chargePoint.updateConnectorStatus(
            this.connectorId,
            OCPPStatus.Charging,
          );
        }
      }
      context.chargePoint.notifyStartTransactionNotAccepted(
        this.connectorId,
        status,
        stopOnInvalid,
      );
    }
  }
}

export class StopTransactionResultHandler implements CallResultHandler<StopTransactionResponseV16> {
  constructor(private connectorId: number) {}

  handle(payload: StopTransactionResponseV16, context: HandlerContext): void {
    context.logger.info(
      `Transaction stopped successfully: ${JSON.stringify(payload)}`,
      LogType.TRANSACTION,
    );
    const connector = context.chargePoint.getConnector(this.connectorId);
    if (connector) {
      connector.transactionId = null;
      connector.stopTransaction();
      // #175: ChargePoint.stopTransaction() already drove Finishing ->
      // Available (when autoResetToAvailable) synchronously at
      // StopTransaction.req send time, and/or a scenario's own explicit
      // `statusChange` node may have done so since — both happen before
      // this CALLRESULT can possibly arrive. Only re-drive (and re-notify)
      // if the connector genuinely hasn't reached Available yet.
      if (
        connector.autoResetToAvailable &&
        connector.status !== OCPPStatus.Available
      ) {
        context.chargePoint.updateConnectorStatus(
          this.connectorId,
          OCPPStatus.Available,
        );
      }
    }
  }
}

export class AuthorizeResultHandler implements CallResultHandler<AuthorizeResponseV16> {
  /** `requestPayload` is the original Authorize.req this CALLRESULT answers
   *  — AuthorizeResponseV16 itself carries no idTag, so the handler needs
   *  it from the request to correlate the `authorizeResult` event
   *  (issue #181). Constructed dynamically per-request by
   *  OCPPMessageHandler.handleCallResult, mirroring MeterValuesResultHandler. */
  constructor(private requestPayload?: AuthorizeRequestV16) {}

  handle(payload: AuthorizeResponseV16, context: HandlerContext): void {
    const { idTagInfo } = payload;
    if (idTagInfo.status === "Accepted") {
      context.logger.info("Authorization successful", LogType.TRANSACTION);
    } else {
      context.logger.warn("Authorization failed", LogType.TRANSACTION);
    }
    if (this.requestPayload) {
      context.chargePoint.notifyAuthorizeResult(
        this.requestPayload.idTag,
        idTagInfo.status,
      );
    }
  }
}
