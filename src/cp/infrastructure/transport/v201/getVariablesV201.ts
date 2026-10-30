import type {
  GetVariablesRequestV201,
  GetVariablesResponseV201,
} from "../../../../ocpp";
import { ConfigurationStore } from "../../../domain/charge-point/ConfigurationStore";
import type { DeviceModelTargets } from "../../../domain/charge-point/DeviceModelTargets";
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
  /** The variables with a Target attribute and their targets (2.1 only);
   *  without it, `Target` is NotSupportedAttributeType everywhere. */
  readonly targets?: DeviceModelTargets;
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

    if (
      data.attributeType === "Target" &&
      context.targets?.supports(v16Key) === true
    ) {
      // B06.FR.03; B06.FR.13: an empty string while no target is set.
      const target = context.targets.get(v16Key);
      return {
        attributeStatus: "Accepted",
        attributeType: "Target",
        attributeValue: target === undefined ? "" : String(target),
        component: data.component,
        variable: data.variable,
      };
    }
    if (data.attributeType !== undefined && data.attributeType !== "Actual") {
      return {
        attributeStatus: "NotSupportedAttributeType", // B06.FR.08
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
