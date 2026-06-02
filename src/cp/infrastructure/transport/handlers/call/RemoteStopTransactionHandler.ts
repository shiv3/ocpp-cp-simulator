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
    const connector = Array.from(context.chargePoint.connectors.values()).find(
      (c) => c.transaction && c.transaction.id === transactionId,
    );

    if (!connector) {
      return { status: "Rejected" };
    }
    if (context.chargePoint.isScenarioStopHandled(connector.id)) {
      // Scenario is parked on a RemoteStopTrigger node — hand the
      // request over rather than stopping the transaction here, so the
      // scenario's own Transaction Stop step runs the §7.36 path.
      context.chargePoint.notifyRemoteStopReceived(connector.id, transactionId);
      return { status: "Accepted" };
    }
    context.chargePoint.updateConnectorStatus(
      connector.id,
      OCPPStatus.SuspendedEVSE,
    );
    // §7.36: stopped via RemoteStopTransaction.req → reason="Remote".
    context.chargePoint.stopTransaction(connector, "Remote");
    return { status: "Accepted" };
  }
}
