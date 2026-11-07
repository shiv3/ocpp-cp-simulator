import type { ChargePoint } from "../../../../domain/charge-point/ChargePoint";
import type { HandlerOutcome } from "../../network-sim/ResponseEffectQueue";

/**
 * What a 1.6 handler returns for an action whose default behavior lives in
 * the charger engine: the response, with the behavior's follow-up as the
 * effect that runs once the response settled.
 */
export function defaultBehavior16(
  chargePoint: ChargePoint,
  action: string,
  payload: unknown,
): unknown {
  const { response, effect } = chargePoint.engine.runDefault(action, payload);
  if (!effect) return response;
  const outcome: HandlerOutcome = {
    kind: "handler-outcome",
    payload: response,
    afterResponseSettled: effect,
  };
  return outcome;
}
