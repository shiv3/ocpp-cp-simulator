import type {
  GetTransactionStatusRequestV201,
  GetTransactionStatusResponseV201,
} from "@ocpp-cp-sim/ocpp/index";
import type {
  V201HandlerResult,
  V201InboundContext,
} from "./inboundRegistryV201";

/** Translation only: `default.transaction` decides (see
 *  `application/engine/behaviors/transaction.ts`). */
function runTransactionDefault(
  action: string,
  payload: unknown,
  ctx: V201InboundContext,
): V201HandlerResult {
  const { response, effect } = ctx.chargePoint.engine.runDefault(
    action,
    payload,
  );
  return { response, ...(effect ? { afterResult: effect } : {}) };
}

export function handleRequestStartTransactionV201(
  payload: unknown,
  ctx: V201InboundContext,
): V201HandlerResult {
  return runTransactionDefault("RequestStartTransaction", payload, ctx);
}

export function handleRequestStopTransactionV201(
  payload: unknown,
  ctx: V201InboundContext,
): V201HandlerResult {
  return runTransactionDefault("RequestStopTransaction", payload, ctx);
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
      // E14.FR.06: no ongoingIndicator without a transactionId.
      ...(req.transactionId !== undefined && { ongoingIndicator }),
      messagesInQueue:
        ctx.hasTransactionEventsToDeliver?.(req.transactionId) ?? false,
    } satisfies GetTransactionStatusResponseV201,
  };
}
