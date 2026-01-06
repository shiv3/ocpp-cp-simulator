import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import * as request from "@voltbras/ts-ocpp/dist/messages/json/request";
import * as response from "@voltbras/ts-ocpp/dist/messages/json/response";
import { OCPPStatus } from "../../../../domain/types/OcppTypes";

export class RemoteStopTransactionHandler
  implements
    CallHandler<
      request.RemoteStopTransactionRequest,
      response.RemoteStopTransactionResponse
    >
{
  handle(
    payload: request.RemoteStopTransactionRequest,
    context: HandlerContext,
  ): response.RemoteStopTransactionResponse {
    const { transactionId } = payload;
    const connector = Array.from(
      context.chargePoint.connectors.values(),
    ).find((c) => c.transaction && c.transaction.id === transactionId);

    if (connector) {
      context.chargePoint.updateConnectorStatus(
        connector.id,
        OCPPStatus.SuspendedEVSE,
      );
      context.chargePoint.stopTransaction(connector);
      return { status: "Accepted" };
    } else {
      return { status: "Rejected" };
    }
  }
}
