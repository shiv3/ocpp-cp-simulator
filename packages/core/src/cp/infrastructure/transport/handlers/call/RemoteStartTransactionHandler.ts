import type { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import type {
  RemoteStartTransactionRequestV16,
  RemoteStartTransactionResponseV16,
} from "@ocpp-cp-simulator/ocpp/index";
import { defaultBehavior16 } from "./defaultBehavior";

/**
 * §5.11: translation only. The `default.transaction` behavior of the charger
 * engine decides (`application/engine/behaviors/transaction.ts`):
 * `AuthorizeRemoteTxRequests`, the scenario delegation and the start.
 */
export class RemoteStartTransactionHandler implements CallHandler<
  RemoteStartTransactionRequestV16,
  RemoteStartTransactionResponseV16
> {
  handle(
    payload: RemoteStartTransactionRequestV16,
    context: HandlerContext,
  ): RemoteStartTransactionResponseV16 {
    return defaultBehavior16(
      context.chargePoint,
      "RemoteStartTransaction",
      payload,
    ) as RemoteStartTransactionResponseV16;
  }
}
