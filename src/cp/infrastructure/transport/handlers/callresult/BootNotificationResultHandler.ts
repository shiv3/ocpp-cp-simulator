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
      // Send connector 0 (charge point level) status first
      context.chargePoint.updateConnectorStatus(0, OCPPStatus.Available);
      context.chargePoint.connectors.forEach((connector) => {
        if (connector.autoResetToAvailable) {
          context.chargePoint.updateConnectorStatus(
            connector.id,
            OCPPStatus.Available,
          );
          return;
        }
        context.chargePoint.updateConnectorStatus(
          connector.id,
          connector.status,
        );
      });
      context.chargePoint.status = OCPPStatus.Available;

      // OCPP 1.6J §4.2: honor BootNotification.conf.interval. >0 means "send
      // a Heartbeat every N seconds"; 0 means the CSMS will pull via
      // TriggerMessage so we shouldn't auto-emit.
      if (typeof payload.interval === "number" && payload.interval > 0) {
        context.chargePoint.startHeartbeat(payload.interval);
        context.logger.info(
          `Periodic Heartbeat enabled at ${payload.interval}s interval`,
          LogType.HEARTBEAT,
        );
      } else {
        context.chargePoint.stopHeartbeat();
      }
    } else {
      context.logger.error("Boot notification failed", LogType.OCPP);
    }
  }
}
