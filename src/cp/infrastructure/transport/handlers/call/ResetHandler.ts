import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import * as request from "@voltbras/ts-ocpp/dist/messages/json/request";
import * as response from "@voltbras/ts-ocpp/dist/messages/json/response";
import { LogType } from "../../../../shared/Logger";

export class ResetHandler
  implements CallHandler<request.ResetRequest, response.ResetResponse>
{
  handle(
    payload: request.ResetRequest,
    context: HandlerContext,
  ): response.ResetResponse {
    context.logger.info(`Reset request received: ${payload.type}`, LogType.OCPP);

    setTimeout(() => {
      context.logger.info(`Reset chargePoint: ${context.chargePoint.id}`, LogType.OCPP);
      if (payload.type === "Hard") {
        context.chargePoint.reset();
      } else {
        context.chargePoint.boot();
      }
    }, 5000);

    return { status: "Accepted" };
  }
}
