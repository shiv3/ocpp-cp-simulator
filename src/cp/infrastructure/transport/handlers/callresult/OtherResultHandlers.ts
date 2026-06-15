import { CallResultHandler, HandlerContext } from "../MessageHandlerRegistry";
import type {} from "@cshil/ocpp-tools";
import { LogType } from "../../../../shared/Logger";

export class HeartbeatResultHandler
  implements CallResultHandler<HeartbeatResponseV16>
{
  handle(payload: HeartbeatResponseV16, context: HandlerContext): void {
    context.logger.debug(
      `Received heartbeat response: ${payload.currentTime}`,
      LogType.HEARTBEAT,
    );
  }
}

export class MeterValuesResultHandler
  implements CallResultHandler<MeterValuesResponseV16>
{
  constructor(private requestPayload?: MeterValuesRequestV16) {}

  handle(payload: MeterValuesResponseV16, context: HandlerContext): void {
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
  implements CallResultHandler<StatusNotificationResponseV16>
{
  handle(
    payload: StatusNotificationResponseV16,
    context: HandlerContext,
  ): void {
    context.logger.debug(
      `Status notification sent successfully: ${JSON.stringify(payload)}`,
      LogType.STATUS,
    );
  }
}

export class DataTransferResultHandler
  implements CallResultHandler<DataTransferResponseV16>
{
  handle(payload: DataTransferResponseV16, context: HandlerContext): void {
    context.logger.info(
      `Data transfer sent successfully: ${JSON.stringify(payload)}`,
      LogType.OCPP,
    );
  }
}
