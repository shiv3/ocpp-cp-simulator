import { CallResultHandler, HandlerContext } from "../MessageHandlerRegistry";
import * as response from "@voltbras/ts-ocpp/dist/messages/json/response";
import { OCPPStatus } from "../../../../domain/types/OcppTypes";
import { LogType } from "../../../../shared/Logger";

export class BootNotificationResultHandler
  implements CallResultHandler<response.BootNotificationResponse>
{
  handle(
    payload: response.BootNotificationResponse,
    context: HandlerContext,
  ): void {
    if (payload.status === "Accepted") {
      context.logger.info("Boot notification successful", LogType.OCPP);
      context.chargePoint.updateAllConnectorsStatus(OCPPStatus.Available);
      context.chargePoint.status = OCPPStatus.Available;
    } else {
      context.logger.error("Boot notification failed", LogType.OCPP);
    }
  }
}
