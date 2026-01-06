import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import * as request from "@voltbras/ts-ocpp/dist/messages/json/request";
import * as response from "@voltbras/ts-ocpp/dist/messages/json/response";
import {
  defaultConfiguration,
  ConfigurationValue,
  StringConfigurationValue,
  BooleanConfigurationValue,
  IntegerConfigurationValue,
  ArrayConfigurationValue,
} from "../../../../domain/charge-point/Configuration";
import { OcppConfigurationKey } from "../../../../domain/types/OcppTypes";
import { LogType } from "../../../../shared/Logger";

export class GetConfigurationHandler
  implements
    CallHandler<
      request.GetConfigurationRequest,
      response.GetConfigurationResponse
    >
{
  handle(
    payload: request.GetConfigurationRequest,
    context: HandlerContext,
  ): response.GetConfigurationResponse {
    context.logger.info(
      `Get configuration request received: ${JSON.stringify(payload.key)}`,
      LogType.CONFIGURATION,
    );

    const configuration = this.mapConfiguration(
      defaultConfiguration(context.chargePoint),
    );

    if (!payload.key || payload.key.length === 0) {
      return {
        configurationKey: configuration,
      };
    }

    const filteredConfig = configuration.filter((c) =>
      payload.key?.includes(c.key),
    );
    const configurationKeys = configuration.map((c) => c.key);
    const unknownKeys = payload.key.filter(
      (c) => !configurationKeys.includes(c),
    );

    return {
      configurationKey: filteredConfig,
      unknownKey: unknownKeys,
    };
  }

  private mapConfiguration(
    config: ConfigurationValue[],
  ): OcppConfigurationKey[] {
    return config.map((c) => ({
      key: c.key.name,
      readonly: c.key.readonly,
      value: this.mapValue(c),
    }));
  }

  private mapValue(value: ConfigurationValue): string {
    switch (value.key.type) {
      case "string":
        return (value as StringConfigurationValue).value;
      case "boolean":
        return String((value as BooleanConfigurationValue).value);
      case "integer":
        return String((value as IntegerConfigurationValue).value);
      case "array":
        return (value as ArrayConfigurationValue).value.join(",");
    }
  }
}
