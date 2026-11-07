import type { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import type { HandlerOutcome } from "../../network-sim/ResponseEffectQueue";
import type {
  GetLogRequestV16,
  GetLogResponseV16,
} from "@ocpp-cp-sim/ocpp/index";
import { defaultBehavior16 } from "./defaultBehavior";

/**
 * §2 GetLog.req (OCPP 1.6 Security Whitepaper): translation only. The
 * charger engine's `default.logs` behavior answers with the file name and
 * follows up with the LogStatusNotification train
 * (`application/engine/behaviors/logs.ts`).
 */
export class GetLogHandler implements CallHandler<
  GetLogRequestV16,
  GetLogResponseV16
> {
  handle(
    payload: GetLogRequestV16,
    context: HandlerContext,
  ): GetLogResponseV16 | HandlerOutcome {
    return defaultBehavior16(context.chargePoint, "GetLog", payload) as
      GetLogResponseV16 | HandlerOutcome;
  }
}
