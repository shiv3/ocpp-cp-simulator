import { CallResultHandler, HandlerContext } from "../MessageHandlerRegistry";
import * as response from "@voltbras/ts-ocpp/dist/messages/json/response";
import { OCPPStatus } from "../../../../domain/types/OcppTypes";
import { LogType } from "../../../../shared/Logger";

export class StartTransactionResultHandler
  implements CallResultHandler<response.StartTransactionResponse>
{
  constructor(private connectorId: number) {}

  handle(
    payload: response.StartTransactionResponse,
    context: HandlerContext,
  ): void {
    const { transactionId, idTagInfo } = payload;
    const connector = context.chargePoint.getConnector(this.connectorId);

    if (idTagInfo.status === "Accepted") {
      if (connector) {
        connector.transactionId = transactionId;
        context.logger.info(
          `StartTransaction accepted for connector ${this.connectorId}, transitioning to Charging`,
          LogType.TRANSACTION,
        );
        context.chargePoint.updateConnectorStatus(
          this.connectorId,
          OCPPStatus.Charging,
        );
      }
    } else {
      context.logger.error("Failed to start transaction", LogType.TRANSACTION);
      if (connector) {
        connector.status = OCPPStatus.Faulted;
        if (connector.transaction && connector.transaction.meterSent) {
          context.chargePoint.stopTransaction(connector);
        } else {
          context.chargePoint.cleanTransaction(connector);
        }
      } else {
        context.chargePoint.cleanTransaction(this.connectorId);
      }
      context.chargePoint.updateConnectorStatus(
        this.connectorId,
        OCPPStatus.Available,
      );
    }
  }
}

export class StopTransactionResultHandler
  implements CallResultHandler<response.StopTransactionResponse>
{
  constructor(private connectorId: number) {}

  handle(
    payload: response.StopTransactionResponse,
    context: HandlerContext,
  ): void {
    context.logger.info(
      `Transaction stopped successfully: ${JSON.stringify(payload)}`,
      LogType.TRANSACTION,
    );
    const connector = context.chargePoint.getConnector(this.connectorId);
    if (connector) {
      connector.transactionId = null;
      connector.stopTransaction();
      if (connector.autoResetToAvailable) {
        context.chargePoint.updateConnectorStatus(
          this.connectorId,
          OCPPStatus.Available,
        );
      }
    }
  }
}

export class AuthorizeResultHandler
  implements CallResultHandler<response.AuthorizeResponse>
{
  handle(payload: response.AuthorizeResponse, context: HandlerContext): void {
    const { idTagInfo } = payload;
    if (idTagInfo.status === "Accepted") {
      context.logger.info("Authorization successful", LogType.TRANSACTION);
    } else {
      context.logger.warn("Authorization failed", LogType.TRANSACTION);
    }
  }
}
