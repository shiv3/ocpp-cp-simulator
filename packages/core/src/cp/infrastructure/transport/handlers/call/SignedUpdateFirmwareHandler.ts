import type { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import type {
  SignedUpdateFirmwareRequestV16,
  SignedUpdateFirmwareResponseV16,
} from "@ocpp-cp-simulator/ocpp/index";
import type { HandlerOutcome } from "../../network-sim/ResponseEffectQueue";
import { defaultBehavior16 } from "./defaultBehavior";

/**
 * §2 SignedUpdateFirmware.req (OCPP 1.6 Security Whitepaper): translation
 * only. The charger engine's `default.signedFirmware` behavior answers and
 * walks the signed status train
 * (`application/engine/behaviors/signedFirmware.ts`).
 */
export class SignedUpdateFirmwareHandler implements CallHandler<
  SignedUpdateFirmwareRequestV16,
  SignedUpdateFirmwareResponseV16
> {
  handle(
    payload: SignedUpdateFirmwareRequestV16,
    context: HandlerContext,
  ): SignedUpdateFirmwareResponseV16 | HandlerOutcome {
    return defaultBehavior16(
      context.chargePoint,
      "SignedUpdateFirmware",
      payload,
    ) as SignedUpdateFirmwareResponseV16 | HandlerOutcome;
  }
}
