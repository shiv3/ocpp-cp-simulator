import type {
  GetVariablesRequestV201,
  GetVariablesResponseV201,
} from "@cshil/ocpp-tools";
import {
  ConfigurationStore,
  type ArrayConfigurationValue,
  type BooleanConfigurationValue,
  type ConfigurationValue,
  type IntegerConfigurationValue,
  type StringConfigurationValue,
} from "../../../domain/charge-point/ConfigurationStore";
import { KNOWN_V201_COMPONENTS, lookupV16Key } from "./deviceModelMap";

type GetVariableResult = GetVariablesResponseV201["getVariableResult"][number];

export function handleGetVariablesV201(
  req: GetVariablesRequestV201,
  store: ConfigurationStore,
): GetVariablesResponseV201 {
  const results = req.getVariableData.map((data): GetVariableResult => {
    const componentName = data.component.name;
    const variableName = data.variable.name;

    if (!KNOWN_V201_COMPONENTS.has(componentName)) {
      return {
        attributeStatus: "UnknownComponent",
        component: data.component,
        variable: data.variable,
      };
    }

    const v16Key = lookupV16Key(componentName, variableName);
    if (v16Key === undefined) {
      return {
        attributeStatus: "UnknownVariable",
        component: data.component,
        variable: data.variable,
      };
    }

    if (data.attributeType !== undefined && data.attributeType !== "Actual") {
      return {
        attributeStatus: "NotSupportedAttributeType",
        component: data.component,
        variable: data.variable,
      };
    }

    const entry = store.get(v16Key);
    if (entry === undefined) {
      return {
        attributeStatus: "Rejected",
        component: data.component,
        variable: data.variable,
      };
    }

    return {
      attributeStatus: "Accepted",
      attributeType: "Actual",
      attributeValue: renderValue(entry),
      component: data.component,
      variable: data.variable,
    };
  });

  const first = results[0];
  if (first === undefined) {
    throw new Error("GetVariablesRequestV201 must contain getVariableData");
  }

  return {
    getVariableResult: [first, ...results.slice(1)],
  };
}

function renderValue(value: ConfigurationValue): string {
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
