import type { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import type {
  RemoteStopTransactionRequestV16,
  RemoteStopTransactionResponseV16,
} from "@ocpp-cp-sim/ocpp/index";
import { defaultBehavior16 } from "./defaultBehavior";

/**
 * §5.12: translation only; see `default.transaction` in
 * `application/engine/behaviors/transaction.ts`.
 */
export class RemoteStopTransactionHandler implements CallHandler<
  RemoteStopTransactionRequestV16,
  RemoteStopTransactionResponseV16
> {
  handle(
    payload: RemoteStopTransactionRequestV16,
    context: HandlerContext,
  ): RemoteStopTransactionResponseV16 {
    return defaultBehavior16(
      context.chargePoint,
      "RemoteStopTransaction",
      payload,
    ) as RemoteStopTransactionResponseV16;
  }
}
