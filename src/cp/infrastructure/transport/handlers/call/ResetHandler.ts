import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import type {} from "../../../../../ocpp";
import { LogType } from "../../../../shared/Logger";

/**
 * §5.14: on Reset.req the CP SHALL respond with Reset.conf, then SHALL
 * send StopTransaction.req for every in-flight transaction before
 * actually resetting. Soft = graceful (stop, then restart app); Hard =
 * hard reboot but still try to send queued StopTransaction.req afterward.
 *
 * We schedule the work via `queueMicrotask` so Reset.conf is flushed
 * before any StopTransaction.req goes out.
 */
export class ResetHandler
  implements CallHandler<ResetRequestV16, ResetResponseV16>
{
  handle(payload: ResetRequestV16, context: HandlerContext): ResetResponseV16 {
    context.logger.info(
      `Reset request received: ${payload.type}`,
      LogType.OCPP,
    );

    queueMicrotask(() => {
      context.chargePoint.applyRemoteReset(payload.type);
    });

    return { status: "Accepted" };
  }
}
