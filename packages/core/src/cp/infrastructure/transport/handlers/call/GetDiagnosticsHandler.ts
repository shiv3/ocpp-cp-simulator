import type { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import type { HandlerOutcome } from "../../network-sim/ResponseEffectQueue";
import type {
  GetDiagnosticsRequestV16,
  GetDiagnosticsResponseV16,
} from "@ocpp-cp-simulator/ocpp/index";
import { defaultBehavior16 } from "./defaultBehavior";

/**
 * §4.4 + §6.7 GetDiagnostics.req: translation only. The charger engine's
 * `default.diagnostics` behavior answers with the file name and follows up
 * with the DiagnosticsStatusNotification train
 * (`application/engine/behaviors/diagnostics.ts`).
 */
export class GetDiagnosticsHandler implements CallHandler<
  GetDiagnosticsRequestV16,
  GetDiagnosticsResponseV16
> {
  handle(
    payload: GetDiagnosticsRequestV16,
    context: HandlerContext,
  ): GetDiagnosticsResponseV16 | HandlerOutcome {
    return defaultBehavior16(context.chargePoint, "GetDiagnostics", payload) as
      GetDiagnosticsResponseV16 | HandlerOutcome;
  }
}
