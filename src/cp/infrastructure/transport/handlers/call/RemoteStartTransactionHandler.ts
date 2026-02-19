import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import * as request from "@voltbras/ts-ocpp/dist/messages/json/request";
import * as response from "@voltbras/ts-ocpp/dist/messages/json/response";

export class RemoteStartTransactionHandler
  implements
    CallHandler<
      request.RemoteStartTransactionRequest,
      response.RemoteStartTransactionResponse
    >
{
  handle(
    payload: request.RemoteStartTransactionRequest,
    context: HandlerContext,
  ): response.RemoteStartTransactionResponse {
    const { idTag, connectorId } = payload;
    const resolvedConnectorId = connectorId || 1;
    const connector = context.chargePoint.getConnector(resolvedConnectorId);

    if (connector && connector.availability === "Operative") {
      if (context.chargePoint.isScenarioHandled(resolvedConnectorId)) {
        // Scenario is waiting for RemoteStart - let it handle the transaction flow
        context.chargePoint.notifyRemoteStartReceived(
          resolvedConnectorId,
          idTag,
        );
      } else {
        context.chargePoint.startTransaction(idTag, resolvedConnectorId);
      }
      return { status: "Accepted" };
    } else {
      return { status: "Rejected" };
    }
  }
}
