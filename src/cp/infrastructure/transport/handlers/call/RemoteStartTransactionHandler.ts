import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import * as request from "@voltbras/ts-ocpp/dist/messages/json/request";
import * as response from "@voltbras/ts-ocpp/dist/messages/json/response";
import { LogType } from "../../../../shared/Logger";

/**
 * §5.11 + AuthorizeRemoteTxRequests:
 *
 * - When `AuthorizeRemoteTxRequests = true`, the CP MUST authorize the
 *   idTag (via Local Auth List / Authorization Cache / Authorize.req)
 *   before starting the transaction. We don't yet implement local auth,
 *   so we send Authorize.req and continue immediately — CSMS's
 *   StartTransaction.conf will tighten the loop.
 * - When `AuthorizeRemoteTxRequests = false`, start the transaction
 *   directly; CSMS validates the idTag via StartTransaction.req.
 *
 * Charging profiles included in the request are ignored for now; per
 * §5.11, a Charge Point without Smart Charging MAY ignore them.
 * SmartCharging support is wired in a later phase.
 */
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

    if (!connector || connector.availability !== "Operative") {
      return { status: "Rejected" };
    }

    const authorizeFirst =
      context.chargePoint.configuration.getBoolean(
        "AuthorizeRemoteTxRequests",
      ) ?? false;
    if (authorizeFirst) {
      context.logger.info(
        `AuthorizeRemoteTxRequests=true: sending Authorize.req for ${idTag}`,
        LogType.OCPP,
      );
      context.chargePoint.authorize(idTag);
    }

    if (context.chargePoint.isScenarioHandled(resolvedConnectorId)) {
      // Scenario is waiting for RemoteStart - let it handle the transaction flow
      context.chargePoint.notifyRemoteStartReceived(resolvedConnectorId, idTag);
    } else {
      context.chargePoint.startTransaction(idTag, resolvedConnectorId);
    }
    return { status: "Accepted" };
  }
}
