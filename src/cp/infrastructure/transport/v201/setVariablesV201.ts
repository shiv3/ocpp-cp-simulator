import type {
  SetVariablesRequestV201,
  SetVariablesResponseV201,
} from "@cshil/ocpp-tools";
import type {
  ConfigurationChangeStatus,
  ConfigurationStore,
} from "../../../domain/charge-point/ConfigurationStore";
import { KNOWN_V201_COMPONENTS, lookupV16Key } from "./deviceModelMap";

type SetVariableResult = SetVariablesResponseV201["setVariableResult"][number];

export function handleSetVariablesV201(
  req: SetVariablesRequestV201,
  store: ConfigurationStore,
): SetVariablesResponseV201 {
  const results = req.setVariableData.map((data): SetVariableResult => {
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

    const attributeStatus = mapChangeStatus(
      store.applyChange(v16Key, data.attributeValue),
    );

    if (
      attributeStatus === "Accepted" ||
      attributeStatus === "RebootRequired"
    ) {
      return {
        attributeStatus,
        attributeType: "Actual",
        component: data.component,
        variable: data.variable,
      };
    }

    return {
      attributeStatus,
      component: data.component,
      variable: data.variable,
    };
  });

  const first = results[0];
  if (first === undefined) {
    throw new Error("SetVariablesRequestV201 must contain setVariableData");
  }

  return {
    setVariableResult: results as [SetVariableResult, ...SetVariableResult[]],
  };
}

function mapChangeStatus(
  status: ConfigurationChangeStatus,
): SetVariableResult["attributeStatus"] {
  switch (status) {
    case "Accepted":
      return "Accepted";
    case "RebootRequired":
      return "RebootRequired";
    case "Rejected":
    case "NotSupported":
      return "Rejected";
  }
}
