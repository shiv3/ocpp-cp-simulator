import {
  isWriteOnlyConfigurationKey,
  type ConfigurationKeyType,
  type ConfigurationStore,
} from "../../../domain/charge-point/ConfigurationStore";
import type {
  ReportDataType,
  VariableAttributeType,
  VariableCharacteristicsType,
} from "../../../../ocpp/types/v201/notify-report";
import { V201_VARIABLE_TO_V16_KEY } from "./deviceModelMap";
import { renderConfigValue } from "./renderConfigValue";

function toCharacteristicDataType(
  type: ConfigurationKeyType,
): VariableCharacteristicsType["dataType"] {
  switch (type) {
    case "integer":
      return "integer";
    case "boolean":
      return "boolean";
    case "string":
      return "string";
    case "array":
      return "MemberList";
  }
}

export function buildBaseReportData(
  store: ConfigurationStore,
): ReportDataType[] {
  const reportData: ReportDataType[] = [];

  for (const [v201Key, v16Key] of V201_VARIABLE_TO_V16_KEY) {
    const entry = store.get(v16Key);
    if (!entry) continue;

    const separatorIndex = v201Key.indexOf("/");
    const componentName = v201Key.slice(0, separatorIndex);
    const variableName = v201Key.slice(separatorIndex + 1);
    const mutability = isWriteOnlyConfigurationKey(entry.key)
      ? "WriteOnly"
      : entry.key.readonly
        ? "ReadOnly"
        : "ReadWrite";

    reportData.push({
      component: { name: componentName },
      variable: { name: variableName },
      variableAttribute: [
        {
          type: "Actual",
          value: renderConfigValue(entry),
          mutability,
        },
      ] as [VariableAttributeType],
      variableCharacteristics: {
        dataType: toCharacteristicDataType(entry.key.type),
        supportsMonitoring: false,
      },
    });
  }

  return reportData;
}
