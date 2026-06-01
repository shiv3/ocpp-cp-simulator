import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import * as request from "@voltbras/ts-ocpp/dist/messages/json/request";
import * as response from "@voltbras/ts-ocpp/dist/messages/json/response";
import { LogType } from "../../../../shared/Logger";

export class ChangeConfigurationHandler
  implements
    CallHandler<
      request.ChangeConfigurationRequest,
      response.ChangeConfigurationResponse
    >
{
  handle(
    payload: request.ChangeConfigurationRequest,
    context: HandlerContext,
  ): response.ChangeConfigurationResponse {
    context.logger.info(
      `Change configuration request received: ${JSON.stringify(payload.key)}: ${JSON.stringify(payload.value)}`,
      LogType.CONFIGURATION,
    );
    // Currently not supported - can be extended in the future
    return { status: "NotSupported" };
  }
}

export class TriggerMessageHandler
  implements
    CallHandler<request.TriggerMessageRequest, response.TriggerMessageResponse>
{
  handle(
    payload: request.TriggerMessageRequest,
    context: HandlerContext,
  ): response.TriggerMessageResponse {
    context.logger.info(
      `Trigger message request received: ${payload.requestedMessage}` +
        (payload.connectorId !== undefined
          ? ` (connectorId=${payload.connectorId})`
          : ""),
      LogType.OCPP,
    );

    // OCPP 1.6J §6.51: the response is sent first (Accepted/Rejected), then
    // the CP fires the requested message after answering. Schedule via
    // queueMicrotask so the CALLRESULT goes out before the new CALL.
    switch (payload.requestedMessage) {
      case "StatusNotification":
        queueMicrotask(() =>
          context.chargePoint.sendCurrentStatusNotification(
            payload.connectorId,
          ),
        );
        return { status: "Accepted" };

      case "Heartbeat":
        queueMicrotask(() => context.chargePoint.sendHeartbeat());
        return { status: "Accepted" };

      case "MeterValues": {
        const targetConnectorId = payload.connectorId;
        queueMicrotask(() => {
          if (targetConnectorId === undefined || targetConnectorId === 0) {
            for (const id of context.chargePoint.connectors.keys()) {
              context.chargePoint.sendMeterValue(id);
            }
            return;
          }
          context.chargePoint.sendMeterValue(targetConnectorId);
        });
        return { status: "Accepted" };
      }

      case "BootNotification":
      case "DiagnosticsStatusNotification":
      case "FirmwareStatusNotification":
        // Not implemented yet — let the CSMS know we won't honor these
        // rather than silently swallowing them.
        return { status: "NotImplemented" };

      default:
        return { status: "NotImplemented" };
    }
  }
}

export class ClearCacheHandler
  implements
    CallHandler<request.ClearCacheRequest, response.ClearCacheResponse>
{
  handle(
    payload: request.ClearCacheRequest,
    context: HandlerContext,
  ): response.ClearCacheResponse {
    context.logger.info(
      `Clear cache request received: ${JSON.stringify(payload)}`,
      LogType.OCPP,
    );
    return { status: "Accepted" };
  }
}

export class UnlockConnectorHandler
  implements
    CallHandler<
      request.UnlockConnectorRequest,
      response.UnlockConnectorResponse
    >
{
  handle(
    payload: request.UnlockConnectorRequest,
    context: HandlerContext,
  ): response.UnlockConnectorResponse {
    context.logger.info(
      `Unlock connector request received: ${JSON.stringify(payload)}`,
      LogType.OCPP,
    );
    return { status: "NotSupported" };
  }
}
