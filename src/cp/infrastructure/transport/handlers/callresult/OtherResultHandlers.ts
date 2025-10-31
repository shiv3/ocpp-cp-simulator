import { CallResultHandler, HandlerContext } from "../MessageHandlerRegistry";
import * as response from "@voltbras/ts-ocpp/dist/messages/json/response";
import * as request from "@voltbras/ts-ocpp/dist/messages/json/request";
import { LogType } from "../../../../shared/Logger";

export class HeartbeatResultHandler
  implements CallResultHandler<response.HeartbeatResponse>
{
  handle(
    payload: response.HeartbeatResponse,
    context: HandlerContext,
  ): void {
    context.logger.debug(`Received heartbeat response: ${payload.currentTime}`, LogType.HEARTBEAT);
  }
}

export class MeterValuesResultHandler
  implements CallResultHandler<response.MeterValuesResponse>
{
  constructor(private requestPayload?: request.MeterValuesRequest) {}

  handle(
    payload: response.MeterValuesResponse,
    context: HandlerContext,
  ): void {
    if (this.requestPayload) {
      const connector = context.chargePoint.getConnector(
        this.requestPayload.connectorId,
      );
      if (connector && connector.transaction) {
        connector.transaction.meterSent = true;
      }
    }
    context.logger.debug(
      `Meter values sent successfully: ${JSON.stringify(payload)}`,
      LogType.METER_VALUE,
    );
  }
}

export class StatusNotificationResultHandler
  implements CallResultHandler<response.StatusNotificationResponse>
{
  handle(
    payload: response.StatusNotificationResponse,
    context: HandlerContext,
  ): void {
    context.logger.debug(
      `Status notification sent successfully: ${JSON.stringify(payload)}`,
      LogType.STATUS,
    );
  }
}

export class DataTransferResultHandler
  implements CallResultHandler<response.DataTransferResponse>
{
  handle(
    payload: response.DataTransferResponse,
    context: HandlerContext,
  ): void {
    context.logger.info(
      `Data transfer sent successfully: ${JSON.stringify(payload)}`,
      LogType.OCPP,
    );
  }
}
