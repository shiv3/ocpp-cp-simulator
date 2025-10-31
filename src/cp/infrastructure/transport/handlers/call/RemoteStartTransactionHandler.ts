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
    const connector = context.chargePoint.getConnector(connectorId || 1);

    if (connector && connector.availability === "Operative") {
      context.chargePoint.startTransaction(idTag, connectorId || 1);
      return { status: "Accepted" };
    } else {
      return { status: "Rejected" };
    }
  }
}
