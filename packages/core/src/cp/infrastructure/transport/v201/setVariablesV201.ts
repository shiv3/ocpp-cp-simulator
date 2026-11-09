import type {
  SetVariablesRequestV201,
  SetVariablesResponseV201,
} from "@ocpp-cp-simulator/ocpp/index";
import type { ConfigurationStore } from "../../../domain/charge-point/ConfigurationStore";
import type { DeviceModelContext } from "./getVariablesV201";
import { resolveDeviceModelVariable } from "./deviceModelMap";
import {
  checkRange,
  checkVariableValue,
  parseDecimal,
  REASON,
  statusInfo,
  type VariableStatusInfo,
} from "./variableStatusInfo";
import { variablesRequestLimitViolation } from "./variablesRequestLimits";
import { unknownMeasurands } from "./measurandEnum";
import {
  DEVICE_MODEL,
  type DeviceModelVariableDef,
} from "../../../domain/device-model/DeviceModelRegistry";

/** The configuration keys behind the MemberLists over MeasurandEnumType
 *  (`SampledDataCtrlr.TxUpdatedMeasurands`, `AlignedDataCtrlr.Measurands`,
 *  and the three TxStarted / TxEnded lists, #607). */
const MEASURAND_LIST_KEYS: ReadonlySet<string> = new Set([
  "MeterValuesSampledData",
  "MeterValuesAlignedData",
  // SampledDataCtrlr.TxStartedMeasurands / TxEndedMeasurands and
  // AlignedDataCtrlr.TxEndedMeasurands (#607).
  "TxStartedMeasurands",
  "StopTxnSampledData",
  "StopTxnAlignedData",
]);

/**
 * Why `value` is not one `def` can hold, or `undefined` when it is: a
 * MemberList member outside the version's MeasurandEnumType (B05.FR.07,
 * #714; checked first so the reason names the members), then the type,
 * limits and OptionList (B05.FR.07/08).
 */
export function variableValueRejection(
  def: DeviceModelVariableDef,
  v16Key: string,
  value: string,
  ocppVersion: string | undefined,
): VariableStatusInfo | undefined {
  if (ocppVersion !== undefined && MEASURAND_LIST_KEYS.has(v16Key)) {
    const members = value
      .split(",")
      .map((m) => m.trim())
      .filter((m) => m !== "");
    const unknown = unknownMeasurands(members, ocppVersion);
    if (unknown.length > 0) {
      return statusInfo(
        REASON.invalidValue,
        `Not a MeasurandEnumType value: ${unknown.join(", ")}`.slice(0, 512),
      );
    }
  }
  return checkVariableValue(def, value);
}

/**
 * The SetVariables value checks for an operator's write of a 2.x
 * configuration key (`cp.config_keys.set`, #612), so the control plane
 * cannot store what a CSMS would be refused. `true` when `value` is
 * acceptable; a key outside the Device Model is left to the store.
 */
export function configurationWriteCheckV201(
  ocppVersion: string,
): (key: string, value: string) => boolean {
  return (key, value) => {
    const def = DEVICE_MODEL.byValueKey(key);
    return (
      def === undefined ||
      variableValueRejection(def, key, value, ocppVersion) === undefined
    );
  };
}

type SetVariableResult = SetVariablesResponseV201["setVariableResult"][number];

export function handleSetVariablesV201(
  req: SetVariablesRequestV201,
  store: ConfigurationStore,
  context: DeviceModelContext = {},
): SetVariablesResponseV201 {
  // B05.FR.11: over the advertised limits, every element is Rejected with
  // the reason (B05.FR.01: one result per element).
  const violation = variablesRequestLimitViolation(
    "SetVariables",
    req,
    req.setVariableData.length,
    store,
  );
  const results = req.setVariableData.map((data): SetVariableResult => {
    const echo = { component: data.component, variable: data.variable };
    const rejected = (info: VariableStatusInfo): SetVariableResult => ({
      attributeStatus: "Rejected",
      attributeStatusInfo: info,
      ...echo,
    });
    if (violation !== undefined) return rejected(violation);
    const resolved = resolveDeviceModelVariable(
      data.component,
      data.variable,
      context.evseExists,
    );
    if (resolved.status !== "Found") {
      return { attributeStatus: resolved.status, ...echo };
    }
    const v16Key = resolved.valueKey;
    const def = resolved.variable;
    const type = data.attributeType;

    if (
      (type === "Target" || type === "MinSet" || type === "MaxSet") &&
      context.targets?.supports(v16Key) === true
    ) {
      // #538: a decimal; anything else (hex, exponent, padding) is badly
      // formatted (B05.FR.07).
      const value = parseDecimal(data.attributeValue);
      if (value === undefined) {
        return rejected(statusInfo(REASON.invalidValue, "expected a decimal"));
      }
      // B05.FR.08: outside the variable's own limits.
      const outside = checkRange(def, value);
      if (outside !== undefined) return rejected(outside);
      // MinSet / MaxSet bound the Target (Part 1 §4): the Target stays in
      // [MinSet, MaxSet], and MinSet never passes MaxSet.
      const { targets } = context;
      const low =
        type === "MinSet" ? undefined : targets.getLimit(v16Key, "MinSet");
      const high =
        type === "MaxSet" ? undefined : targets.getLimit(v16Key, "MaxSet");
      if (type === "MaxSet" || type === "Target") {
        if (low !== undefined && value < low) {
          return rejected(
            statusInfo(REASON.valueOutOfRange, `below the MinSet ${low}`),
          );
        }
      }
      if (type === "MinSet" || type === "Target") {
        if (high !== undefined && value > high) {
          return rejected(
            statusInfo(REASON.valueOutOfRange, `above the MaxSet ${high}`),
          );
        }
      }
      if (type === "Target") targets.set(v16Key, value);
      else targets.setLimit(v16Key, type, value);
      return { attributeStatus: "Accepted", attributeType: type, ...echo }; // B05.FR.03
    }
    if (type !== undefined && type !== "Actual") {
      return { attributeStatus: "NotSupportedAttributeType", ...echo };
    }

    // B05.FR.07, FR.08 first: a badly formatted or out-of-range value is
    // reported as such even for a ReadOnly variable (FR.09 applies only when
    // FR.04-FR.08 do not).
    const badValue = variableValueRejection(
      def,
      v16Key,
      data.attributeValue,
      context.ocppVersion,
    );
    if (badValue !== undefined) return rejected(badValue);
    if (def.mutability === "ReadOnly") {
      return rejected(statusInfo(REASON.readOnly)); // B05.FR.09
    }

    const change = store.applyChange(v16Key, data.attributeValue);
    switch (change) {
      case "Accepted":
      case "RebootRequired":
        return { attributeStatus: change, attributeType: "Actual", ...echo };
      case "NotSupported":
        return rejected(
          statusInfo(
            REASON.missingDevModelInfo,
            "the station holds no value for this variable",
          ),
        );
      case "Rejected":
        // The store refused what the registry checks passed (for example a
        // member of a MemberList it does not know).
        return rejected(statusInfo(REASON.invalidValue));
    }
  });

  const first = results[0];
  if (first === undefined) {
    throw new Error("SetVariablesRequestV201 must contain setVariableData");
  }

  return {
    setVariableResult: results as [SetVariableResult, ...SetVariableResult[]],
  };
}
