import type {
  GetVariablesRequestV201,
  GetVariablesResponseV201,
} from "@ocpp-cp-simulator/ocpp/index";
import type { ConfigurationStore } from "../../../domain/charge-point/ConfigurationStore";
import type { DeviceModelTargets } from "../../../domain/charge-point/DeviceModelTargets";
import {
  resolveDeviceModelVariable,
  type DeviceModelEvse,
} from "./deviceModelMap";
import { renderConfigValue } from "../../../domain/charge-point/renderConfigValue";
import { REASON, statusInfo } from "./variableStatusInfo";
import { variablesRequestLimitViolation } from "./variablesRequestLimits";

type GetVariableResult = GetVariablesResponseV201["getVariableResult"][number];

/** What the station's topology adds to the device-model lookup (#538). */
export interface DeviceModelContext {
  /** Whether the station has this EVSE (and connector); without it, no
   *  EVSE-scoped variable resolves. */
  readonly evseExists?: (evse: DeviceModelEvse) => boolean;
  /** The variables with a Target attribute and their targets (2.1 only);
   *  without it, `Target` is NotSupportedAttributeType everywhere. */
  readonly targets?: DeviceModelTargets;
  /** The station's OCPP version, to pick the `MeasurandEnumType` a measurand
   *  list is checked against (#714); without it, lists are not checked. */
  readonly ocppVersion?: string;
}

export function handleGetVariablesV201(
  req: GetVariablesRequestV201,
  store: ConfigurationStore,
  context: DeviceModelContext = {},
): GetVariablesResponseV201 {
  // B06.FR.05: over the advertised limits, every element is Rejected with
  // the reason (B06.FR.01: one result per element).
  const violation = variablesRequestLimitViolation(
    "GetVariables",
    req,
    req.getVariableData.length,
    store,
  );
  const results = req.getVariableData.map((data): GetVariableResult => {
    if (violation !== undefined) {
      return {
        attributeStatus: "Rejected",
        attributeStatusInfo: violation,
        component: data.component,
        variable: data.variable,
      };
    }
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
      (data.attributeType === "Target" ||
        data.attributeType === "MinSet" ||
        data.attributeType === "MaxSet") &&
      context.targets?.supports(v16Key) === true
    ) {
      // B06.FR.03; B06.FR.13: an empty string while the attribute is unset.
      const value =
        data.attributeType === "Target"
          ? context.targets.get(v16Key)
          : context.targets.getLimit(v16Key, data.attributeType);
      return {
        attributeStatus: "Accepted",
        attributeType: data.attributeType,
        attributeValue: value === undefined ? "" : String(value),
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

    if (resolved.variable.mutability === "WriteOnly") {
      return {
        attributeStatus: "Rejected", // B06.FR.09
        attributeStatusInfo: statusInfo(REASON.writeOnly),
        component: data.component,
        variable: data.variable,
      };
    }
    const entry = store.get(v16Key);
    if (entry === undefined) {
      return {
        attributeStatus: "Rejected",
        attributeStatusInfo: statusInfo(
          REASON.missingDevModelInfo,
          "the station holds no value for this variable",
        ),
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
