import {
  isWriteOnlyConfigurationKey,
  type ArrayConfigurationValue,
  type BooleanConfigurationValue,
  type ConfigurationValue,
  type IntegerConfigurationValue,
  type StringConfigurationValue,
} from "../../../domain/charge-point/ConfigurationStore";

export function renderConfigValue(value: ConfigurationValue): string {
  if (isWriteOnlyConfigurationKey(value.key)) return "";

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
