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
    CallHandler<
      request.TriggerMessageRequest,
      response.TriggerMessageResponse
    >
{
  handle(
    payload: request.TriggerMessageRequest,
    context: HandlerContext,
  ): response.TriggerMessageResponse {
    context.logger.info(
      `Trigger message request received: ${payload.requestedMessage}`,
      LogType.OCPP,
    );
    return { status: "Accepted" };
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
