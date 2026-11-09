import type { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import type { HandlerOutcome } from "../../network-sim/ResponseEffectQueue";
import type {
  ResetRequestV16,
  ResetResponseV16,
} from "@ocpp-cp-simulator/ocpp/index";
import { defaultBehavior16 } from "./defaultBehavior";

/**
 * §5.14 Reset.req: translation only. The charger engine's `default.reset`
 * behavior answers `Accepted` and, once the response settled, stops the
 * transactions in flight and resets (`application/engine/behaviors/reset.ts`).
 */
export class ResetHandler implements CallHandler<
  ResetRequestV16,
  ResetResponseV16
> {
  handle(
    payload: ResetRequestV16,
    context: HandlerContext,
  ): ResetResponseV16 | HandlerOutcome {
    return defaultBehavior16(context.chargePoint, "Reset", payload) as
      ResetResponseV16 | HandlerOutcome;
  }
}
