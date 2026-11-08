import type {
  SetVariablesRequestV201,
  SetVariablesResponseV201,
} from "@ocpp-cp-sim/ocpp/index";
import type {
  ConfigurationChangeStatus,
  ConfigurationStore,
} from "../../../domain/charge-point/ConfigurationStore";
import type { DeviceModelContext } from "./getVariablesV201";
import { resolveDeviceModelVariable } from "./deviceModelMap";
import { unknownMeasurands } from "./measurandEnum";

/** The configuration keys behind the MemberLists over MeasurandEnumType
 *  (`SampledDataCtrlr.TxUpdatedMeasurands`, `AlignedDataCtrlr.Measurands`). */
const MEASURAND_LIST_KEYS: ReadonlySet<string> = new Set([
  "MeterValuesSampledData",
  "MeterValuesAlignedData",
]);

type SetVariableResult = SetVariablesResponseV201["setVariableResult"][number];

/** A plain decimal number: optional minus sign, digits, optional fraction. */
const DECIMAL = /^-?\d+(\.\d+)?$/;

export function handleSetVariablesV201(
  req: SetVariablesRequestV201,
  store: ConfigurationStore,
  context: DeviceModelContext = {},
): SetVariablesResponseV201 {
  const results = req.setVariableData.map((data): SetVariableResult => {
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
      // #538: a decimal target; anything else (hex, exponent, padding) is
      // badly formatted (B05.FR.07).
      const target = DECIMAL.test(data.attributeValue)
        ? Number(data.attributeValue)
        : NaN;
      if (!Number.isFinite(target)) {
        return {
          attributeStatus: "Rejected",
          component: data.component,
          variable: data.variable,
        };
      }
      context.targets.set(v16Key, target);
      return {
        attributeStatus: "Accepted",
        attributeType: "Target", // B05.FR.03
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

    // B05.FR.07: a MemberList value "incorrectly formatted for the given
    // Variable" is Rejected - here a member outside MeasurandEnumType
    // (Temperature and RPM are 1.6 measurands). The previous list is kept.
    if (context.ocppVersion !== undefined && MEASURAND_LIST_KEYS.has(v16Key)) {
      const members = data.attributeValue
        .split(",")
        .map((m) => m.trim())
        .filter((m) => m !== "");
      const unknown = unknownMeasurands(members, context.ocppVersion);
      if (unknown.length > 0) {
        return {
          attributeStatus: "Rejected",
          attributeStatusInfo: {
            reasonCode: "InvalidValue",
            additionalInfo:
              `Not a MeasurandEnumType value: ${unknown.join(", ")}`.slice(
                0,
                512,
              ),
          },
          component: data.component,
          variable: data.variable,
        };
      }
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
