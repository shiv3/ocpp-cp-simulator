import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import type {
  GetConfigurationRequestV16,
  GetConfigurationResponseV16,
} from "../../../../../ocpp";
import type {
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
    CallHandler<GetConfigurationRequestV16, GetConfigurationResponseV16>
{
  handle(
    payload: GetConfigurationRequestV16,
    context: HandlerContext,
  ): GetConfigurationResponseV16 {
    context.logger.info(
      `GetConfiguration request: ${JSON.stringify(payload.key ?? "<all>")}`,
      LogType.CONFIGURATION,
    );

    const store = context.chargePoint.configuration;
    const { known, unknown } = store.readRedacted(payload.key ?? []);
    const configurationKey = this.mapConfiguration(known);
    // §5.8 says unknownKey is optional; only include it when non-empty so
    // the response is the smallest legal payload.
    if (unknown.length === 0) {
      return { configurationKey };
    }
    return { configurationKey, unknownKey: unknown };
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
