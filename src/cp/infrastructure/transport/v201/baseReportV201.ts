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
import type { ConfigurationValue } from "../../../domain/charge-point/ConfigurationStore";
import type { DeviceModelTargets } from "../../../domain/charge-point/DeviceModelTargets";
import { evseValueKey } from "../../../domain/charge-point/runtimeValueKeys";
import {
  parseV201VariableKey,
  V201_EVSE_VARIABLES,
  V201_VARIABLE_TO_V16_KEY,
} from "./deviceModelMap";
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

/**
 * One ReportData per mapped variable the store has: the station-wide ones,
 * then (#538) the per-EVSE runtime values of every EVSE in `evseIds`, with
 * the Target attribute of the variables that have one (2.1).
 */
export function buildBaseReportData(
  store: ConfigurationStore,
  evseIds: Iterable<number> = [],
  targets?: DeviceModelTargets,
): ReportDataType[] {
  const reportData: ReportDataType[] = [];

  for (const [v201Key, v16Key] of V201_VARIABLE_TO_V16_KEY) {
    const entry = store.get(v16Key);
    if (!entry) continue;

    const { component, variable, instance } = parseV201VariableKey(v201Key);
    reportData.push(
      reportDatum(
        { name: component },
        {
          name: variable,
          ...(instance !== undefined ? { instance } : {}),
        },
        entry,
      ),
    );
  }

  const evses = [...evseIds].filter((id) => id >= 1).sort((a, b) => a - b);
  for (const evseId of evses) {
    for (const [v201Key, { keyPrefix, unit }] of V201_EVSE_VARIABLES) {
      const valueKey = evseValueKey(keyPrefix, evseId);
      const entry = store.get(valueKey);
      if (!entry) continue;
      const { component, variable } = parseV201VariableKey(v201Key);
      const datum = reportDatum(
        {
          name: component,
          // EVSE N has one connector, number 1.
          evse:
            component === "Connector"
              ? { id: evseId, connectorId: 1 }
              : { id: evseId },
        },
        { name: variable },
        entry,
        unit,
      );
      if (targets?.supports(valueKey) === true) {
        const target = targets.get(valueKey);
        datum.variableAttribute = [
          datum.variableAttribute[0],
          {
            type: "Target",
            ...(target !== undefined && { value: String(target) }),
            mutability: "ReadWrite",
          },
        ];
      }
      reportData.push(datum);
    }
  }

  return reportData;
}

function reportDatum(
  component: ReportDataType["component"],
  variable: ReportDataType["variable"],
  entry: ConfigurationValue,
  unit?: string,
): ReportDataType {
  const mutability = isWriteOnlyConfigurationKey(entry.key)
    ? "WriteOnly"
    : entry.key.readonly
      ? "ReadOnly"
      : "ReadWrite";
  return {
    component,
    variable,
    variableAttribute: [
      {
        type: "Actual",
        value: renderConfigValue(entry),
        mutability,
      },
    ] as [VariableAttributeType],
    variableCharacteristics: {
      // #538: a string limited to a few values is an OptionList.
      ...(entry.key.type === "string" && entry.key.allowed !== undefined
        ? {
            dataType: "OptionList" as const,
            valuesList: entry.key.allowed.join(","),
          }
        : // #538: a measured value with a unit (EVSE.Power, W) is a decimal
          // in the device model, even when the station reports whole units.
          unit !== undefined
          ? { dataType: "decimal" as const, unit }
          : { dataType: toCharacteristicDataType(entry.key.type) }),
      // #538: the bounds SetVariables and SetVariableMonitoring enforce
      // (a threshold outside them is ValueOutOfRange, N04.FR.06).
      ...(entry.key.type === "integer" &&
        entry.key.min !== undefined && { minLimit: entry.key.min }),
      ...(entry.key.type === "integer" &&
        entry.key.max !== undefined && { maxLimit: entry.key.max }),
      // Every mapped variable accepts at least a Delta monitor (#457).
      supportsMonitoring: true,
    },
  };
}
