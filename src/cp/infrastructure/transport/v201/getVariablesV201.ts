import type {
  GetVariablesRequestV201,
  GetVariablesResponseV201,
} from "../../../../ocpp";
import { ConfigurationStore } from "../../../domain/charge-point/ConfigurationStore";
import {
  resolveDeviceModelVariable,
  type DeviceModelEvse,
} from "./deviceModelMap";
import { renderConfigValue } from "./renderConfigValue";

type GetVariableResult = GetVariablesResponseV201["getVariableResult"][number];

/** What the station's topology adds to the device-model lookup (#538). */
export interface DeviceModelContext {
  /** Whether the station has this EVSE (and connector); without it, no
   *  EVSE-scoped variable resolves. */
  readonly evseExists?: (evse: DeviceModelEvse) => boolean;
}

export function handleGetVariablesV201(
  req: GetVariablesRequestV201,
  store: ConfigurationStore,
  context: DeviceModelContext = {},
): GetVariablesResponseV201 {
  const results = req.getVariableData.map((data): GetVariableResult => {
    const resolved = resolveDeviceModelVariable(
      data.component,
      data.variable,
      context.evseExists,
    );
    if (resolved.status !== "Found") {
      return {
        attributeStatus: resolved.status,
        component: data.component,
        variable: data.variable,
      };
    }
    const v16Key = resolved.valueKey;

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
      attributeValue: renderConfigValue(entry),
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
