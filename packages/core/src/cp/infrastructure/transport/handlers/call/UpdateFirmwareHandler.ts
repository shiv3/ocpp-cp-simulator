import type { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import type { HandlerOutcome } from "../../network-sim/ResponseEffectQueue";
import type {
  UpdateFirmwareRequestV16,
  UpdateFirmwareResponseV16,
} from "@ocpp-cp-simulator/ocpp/index";
import { defaultBehavior16 } from "./defaultBehavior";

/**
 * §6.19 UpdateFirmware.req: translation only. The charger engine's
 * `default.firmware` behavior answers and walks the status train
 * (`application/engine/behaviors/firmware.ts`).
 */
export class UpdateFirmwareHandler implements CallHandler<
  UpdateFirmwareRequestV16,
  UpdateFirmwareResponseV16
> {
  handle(
    payload: UpdateFirmwareRequestV16,
    context: HandlerContext,
  ): UpdateFirmwareResponseV16 | HandlerOutcome {
    return defaultBehavior16(context.chargePoint, "UpdateFirmware", payload) as
      UpdateFirmwareResponseV16 | HandlerOutcome;
  }
}
