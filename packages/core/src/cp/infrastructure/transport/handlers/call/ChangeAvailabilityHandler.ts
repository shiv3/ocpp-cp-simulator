import type { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import type {
  ChangeAvailabilityRequestV16,
  ChangeAvailabilityResponseV16,
} from "@ocpp-cp-sim/ocpp/index";
import { defaultBehavior16 } from "./defaultBehavior";

/**
 * ChangeAvailability.req (OCPP 1.6 §5.2): translation only. The charger
 * engine's `default.availability` behavior decides and applies the change
 * (`application/engine/behaviors/availability.ts`).
 */
export class ChangeAvailabilityHandler implements CallHandler<
  ChangeAvailabilityRequestV16,
  ChangeAvailabilityResponseV16
> {
  handle(
    payload: ChangeAvailabilityRequestV16,
    context: HandlerContext,
  ): ChangeAvailabilityResponseV16 {
    return defaultBehavior16(
      context.chargePoint,
      "ChangeAvailability",
      payload,
    ) as ChangeAvailabilityResponseV16;
  }
}
