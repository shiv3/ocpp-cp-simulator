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

/**
 * E14: with a `transactionId`, `ongoingIndicator` is true for a transaction
 * that has not stopped (E14.FR.02) and false for a stopped or unknown one
 * (E14.FR.01/03). Without an id the response SHALL NOT have it (E14.FR.06).
 * Same on 2.1 (the handler is shared).
 */
export function handleGetTransactionStatusV201(
  payload: unknown,
  ctx: V201InboundContext,
): V201HandlerResult {
  const req = payload as GetTransactionStatusRequestV201;
  const connectors = Array.from(ctx.chargePoint.connectors.values());
  const ongoing =
    req.transactionId === undefined
      ? undefined
      : connectors.some(
          (connector) =>
            connector.transaction?.cpTransactionId === req.transactionId &&
            connector.hasRunningTransaction,
        );

  return {
    response: {
      ...(ongoing === undefined ? {} : { ongoingIndicator: ongoing }),
      messagesInQueue:
        ctx.hasTransactionEventsToDeliver?.(req.transactionId) ?? false,
    } satisfies GetTransactionStatusResponseV201,
  };
}
