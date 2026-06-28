import type {
  GetTransactionStatusRequestV201,
  GetTransactionStatusResponseV201,
  RequestStartTransactionRequestV201,
  RequestStartTransactionResponseV201,
  RequestStopTransactionRequestV201,
  RequestStopTransactionResponseV201,
} from "../../../../ocpp";
import type {
  V201HandlerResult,
  V201InboundContext,
} from "./inboundRegistryV201";

export function handleRequestStartTransactionV201(
  payload: unknown,
  ctx: V201InboundContext,
): V201HandlerResult {
  const req = payload as RequestStartTransactionRequestV201;
  const connectorId = req.evseId ?? 1;
  const connector = ctx.chargePoint.getConnector(connectorId);

  if (!connector || connector.availability !== "Operative") {
    return {
      response: {
        status: "Rejected",
      } satisfies RequestStartTransactionResponseV201,
    };
  }

  return {
    response: {
      status: "Accepted",
    } satisfies RequestStartTransactionResponseV201,
    afterResult: () => {
      const idTag = req.idToken.idToken;
      if (ctx.chargePoint.configuration.authorizeRemoteTxRequests()) {
        ctx.chargePoint.authorize(idTag);
      }
      if (ctx.chargePoint.isScenarioHandled(connectorId)) {
        ctx.chargePoint.notifyRemoteStartReceived(
          connectorId,
          idTag,
          req.remoteStartId,
        );
      } else {
        ctx.chargePoint.startTransaction(
          idTag,
          connectorId,
          undefined,
          undefined,
          {
            triggerReason: "RemoteStart",
            remoteStartId: req.remoteStartId,
          },
        );
      }
    },
  };
}

export function handleRequestStopTransactionV201(
  payload: unknown,
  ctx: V201InboundContext,
): V201HandlerResult {
  const req = payload as RequestStopTransactionRequestV201;
  const connector = Array.from(ctx.chargePoint.connectors.values()).find(
    (candidate) => candidate.transaction?.cpTransactionId === req.transactionId,
  );

  if (!connector) {
    return {
      response: {
        status: "Rejected",
      } satisfies RequestStopTransactionResponseV201,
    };
  }

  const txId = connector.transaction?.id ?? 0;
  return {
    response: {
      status: "Accepted",
    } satisfies RequestStopTransactionResponseV201,
    afterResult: () => {
      if (ctx.chargePoint.isScenarioStopHandled(connector.id)) {
        ctx.chargePoint.notifyRemoteStopReceived(connector.id, txId);
      } else {
        ctx.chargePoint.stopTransaction(connector.id, "Remote", {
          triggerReason: "RemoteStop",
        });
      }
    },
  };
}

export function handleGetTransactionStatusV201(
  payload: unknown,
  ctx: V201InboundContext,
): V201HandlerResult {
  const req = payload as GetTransactionStatusRequestV201;
  const connectors = Array.from(ctx.chargePoint.connectors.values());
  const ongoingIndicator =
    req.transactionId !== undefined
      ? connectors.some(
          (connector) =>
            connector.transaction?.cpTransactionId === req.transactionId,
        )
      : connectors.some((connector) => connector.transaction !== null);

  return {
    response: {
      ongoingIndicator,
      messagesInQueue: false,
    } satisfies GetTransactionStatusResponseV201,
  };
}
