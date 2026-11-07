import type { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import type {
  CancelReservationRequestV16,
  CancelReservationResponseV16,
  ReserveNowRequestV16,
  ReserveNowResponseV16,
} from "@ocpp-cp-sim/ocpp/index";
import { defaultBehavior16 } from "./defaultBehavior";

/**
 * ReserveNow.req: translation only. The charger engine's
 * `default.reservation` behavior decides and reserves the connector
 * (`application/engine/behaviors/reservation.ts`).
 */
export class ReserveNowHandler implements CallHandler<
  ReserveNowRequestV16,
  ReserveNowResponseV16
> {
  handle(
    payload: ReserveNowRequestV16,
    context: HandlerContext,
  ): ReserveNowResponseV16 {
    return defaultBehavior16(
      context.chargePoint,
      "ReserveNow",
      payload,
    ) as ReserveNowResponseV16;
  }
}

/** CancelReservation.req: translation only, like {@link ReserveNowHandler}. */
export class CancelReservationHandler implements CallHandler<
  CancelReservationRequestV16,
  CancelReservationResponseV16
> {
  handle(
    payload: CancelReservationRequestV16,
    context: HandlerContext,
  ): CancelReservationResponseV16 {
    return defaultBehavior16(
      context.chargePoint,
      "CancelReservation",
      payload,
    ) as CancelReservationResponseV16;
  }
}
