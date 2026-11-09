import type { ConfigurationStore } from "../../../domain/charge-point/ConfigurationStore";
import type {
  ReportDataType,
  VariableAttributeType,
} from "@ocpp-cp-sim/ocpp/types/v201/notify-report";
import type { ConfigurationValue } from "../../../domain/charge-point/ConfigurationStore";
import type { DeviceModelTargets } from "../../../domain/charge-point/DeviceModelTargets";
import { evseValueKey } from "../../../domain/charge-point/runtimeValueKeys";
import {
  DEVICE_MODEL,
  type DeviceModelRegistry,
  type DeviceModelVariableDef,
} from "../../../domain/device-model/DeviceModelRegistry";
import { renderConfigValue } from "./renderConfigValue";

/**
 * One ReportData per registered variable the store has a value for: the
 * station-wide ones, then (#538) the per-EVSE runtime values of every EVSE in
 * `evseIds`, with the Target attribute of the variables that have one (2.1).
 * Mutability, data type, limits and unit come from the registry (#604).
 */
export function buildBaseReportData(
  store: ConfigurationStore,
  evseIds: Iterable<number> = [],
  targets?: DeviceModelTargets,
  registry: DeviceModelRegistry = DEVICE_MODEL,
): ReportDataType[] {
  const reportData: ReportDataType[] = [];
  const evseScoped = (def: DeviceModelVariableDef): boolean =>
    registry.isEvseScoped(def.component);

  for (const def of registry.variables) {
    if (evseScoped(def)) continue;
    const entry = store.get(def.valueKey);
    if (!entry) continue;
    reportData.push(
      reportDatum(
        { name: def.component },
        {
          name: def.variable,
          ...(def.instance !== undefined ? { instance: def.instance } : {}),
        },
        entry,
        def,
      ),
    );
  }

  const evses = [...evseIds].filter((id) => id >= 1).sort((a, b) => a - b);
  for (const evseId of evses) {
    for (const def of registry.variables) {
      if (!evseScoped(def)) continue;
      const valueKey = evseValueKey(def.valueKey, evseId);
      const entry = store.get(valueKey);
      if (!entry) continue;
      const datum = reportDatum(
        {
          name: def.component,
          // EVSE N has one connector, number 1.
          evse:
            def.component === "Connector"
              ? { id: evseId, connectorId: 1 }
              : { id: evseId },
        },
        { name: def.variable },
        entry,
        def,
      );
      if (targets?.supports(valueKey) === true) {
        const target = targets.get(valueKey);
        const [actual] = datum.variableAttribute;
        const minSet = targets.getLimit(valueKey, "MinSet");
        const maxSet = targets.getLimit(valueKey, "MaxSet");
        // MinSet / MaxSet bound the Target and are reported once set (B05
        // remark).
        const attribute = (type: "MinSet" | "MaxSet", value: number) => ({
          type,
          value: String(value),
          mutability: "ReadWrite" as const,
        });
        datum.variableAttribute = [
          actual,
          {
            type: "Target",
            ...(target !== undefined && { value: String(target) }),
            mutability: "ReadWrite",
          },
          ...(minSet !== undefined ? [attribute("MinSet", minSet)] : []),
          ...(maxSet !== undefined ? [attribute("MaxSet", maxSet)] : []),
        ] as ReportDataType["variableAttribute"];
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
  def: DeviceModelVariableDef,
): ReportDataType {
  return {
    component,
    variable,
    variableAttribute: [
      {
        type: "Actual",
        // B07.FR.03: the value of a WriteOnly variable is never reported.
        ...(def.mutability !== "WriteOnly" && {
          value: renderConfigValue(entry),
        }),
        mutability: def.mutability,
      },
    ] as [VariableAttributeType],
    variableCharacteristics: {
      dataType: def.dataType,
      ...(def.valuesList !== undefined && {
        valuesList: def.valuesList.join(","),
      }),
      ...(def.unit !== undefined && { unit: def.unit }),
      // The bounds SetVariables and SetVariableMonitoring enforce (a
      // threshold outside them is ValueOutOfRange, N04.FR.06).
      ...(def.min !== undefined && { minLimit: def.min }),
      ...(def.max !== undefined && { maxLimit: def.max }),
      // Every registered variable accepts at least a Delta monitor (#457).
      supportsMonitoring: true,
    },
  };
}

export type ReportBase =
  "ConfigurationInventory" | "FullInventory" | "SummaryInventory";

const isWritable = (rd: ReportDataType): boolean =>
  rd.variableAttribute.some((a) => a.mutability !== "ReadOnly");

/** `AvailabilityState`, the variable a summary is made of (B07.FR.09). */
const isAvailability = (rd: ReportDataType): boolean =>
  rd.variable.name === "AvailabilityState";

/**
 * The part of the full device-model report that `reportBase` asks for
 * (B07.FR.07-FR.09), in the full report's order:
 *
 * - `FullInventory`: everything.
 * - `ConfigurationInventory`: the component-variables the operator can set,
 *   i.e. with a ReadWrite or WriteOnly attribute (B07.FR.07).
 * - `SummaryInventory`: `AvailabilityState` of the Charging Station and of
 *   every EVSE, and of a Connector only when it differs from its EVSE's
 *   ("if known and different from EVSE", B07.FR.09 note). The simulator
 *   registers no Active / Problem / Tripped / Overload / Fallback variable,
 *   so there is no abnormal-state part to add.
 */
export function selectReportBase(
  full: readonly ReportDataType[],
  reportBase: ReportBase,
): ReportDataType[] {
  switch (reportBase) {
    case "FullInventory":
      return [...full];
    case "ConfigurationInventory":
      return full.filter(isWritable);
    case "SummaryInventory": {
      const evseState = new Map<number, string | undefined>();
      for (const rd of full) {
        if (rd.component.name === "EVSE" && isAvailability(rd)) {
          const id = rd.component.evse?.id;
          if (id !== undefined) {
            evseState.set(id, rd.variableAttribute[0].value);
          }
        }
      }
      return full.filter((rd) => {
        if (!isAvailability(rd)) return false;
        if (rd.component.name === "Connector") {
          const id = rd.component.evse?.id;
          return (
            id === undefined ||
            rd.variableAttribute[0].value !== evseState.get(id)
          );
        }
        return (
          rd.component.name === "ChargingStation" ||
          rd.component.name === "EVSE"
        );
      });
    }
  }
}
