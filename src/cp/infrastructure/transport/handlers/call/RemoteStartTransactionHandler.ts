import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import type {} from "../../../../../ocpp";
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
export class RemoteStartTransactionHandler implements CallHandler<
  RemoteStartTransactionRequestV16,
  RemoteStartTransactionResponseV16
> {
  handle(
    payload: RemoteStartTransactionRequestV16,
    context: HandlerContext,
  ): RemoteStartTransactionResponseV16 {
    const { idTag, connectorId } = payload;
    const resolvedConnectorId = connectorId || 1;
    const connector = context.chargePoint.getConnector(resolvedConnectorId);

    if (!connector || connector.availability !== "Operative") {
      return { status: "Rejected" };
    }

    const authorizeFirst =
      context.chargePoint.configuration.authorizeRemoteTxRequests();
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
      // triggerReason: "RemoteStart" marks this as CSMS-initiated so
      // ChargePoint.startTransaction's #181 local-authorize gate doesn't
      // double-authorize on top of the AuthorizeRemoteTxRequests handling
      // above (parity with the OCPP 2.0.1 RequestStartTransaction path).
      context.chargePoint.startTransaction(
        idTag,
        resolvedConnectorId,
        undefined,
        undefined,
        {
          triggerReason: "RemoteStart",
        },
      );
    }
    return { status: "Accepted" };
  }
}
