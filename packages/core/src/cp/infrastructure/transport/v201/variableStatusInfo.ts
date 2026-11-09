// Reason codes and value checks for GetVariables / SetVariables (#606).
// Reason codes are those of OCPP 2.0.1 / 2.1 Part 2 Appendices §5 (the same
// in both editions); the clauses are B05.FR.04-FR.10 and B06.FR.06-FR.09.
import type { DeviceModelVariableDef } from "../../../domain/device-model/DeviceModelRegistry";

/** `StatusInfoType`, as GetVariableResult / SetVariableResult carry it. */
export interface VariableStatusInfo {
  reasonCode: string;
  additionalInfo?: string;
}

export const REASON = {
  readOnly: "ReadOnly",
  writeOnly: "WriteOnly",
  invalidValue: "InvalidValue",
  valueOutOfRange: "ValueOutOfRange",
  tooManyElements: "TooManyElements",
  tooLargeElement: "TooLargeElement",
  missingDevModelInfo: "MissingDevModelInfo",
} as const;

export function statusInfo(
  reasonCode: string,
  additionalInfo?: string,
): VariableStatusInfo {
  return additionalInfo === undefined
    ? { reasonCode }
    : { reasonCode, additionalInfo };
}

const INTEGER = /^-?\d+$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;

/** A plain decimal number, or `undefined` (hex, exponent, padding, text). */
export function parseDecimal(raw: string): number | undefined {
  if (!DECIMAL.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Why `raw` is not a value `def` can hold, or `undefined` when it is one.
 * A malformed value (B05.FR.07) is `InvalidValue`, a number outside the
 * variable's limits (B05.FR.08) is `ValueOutOfRange`, and a value outside an
 * OptionList is `InvalidValue`.
 */
export function checkVariableValue(
  def: DeviceModelVariableDef,
  raw: string,
): VariableStatusInfo | undefined {
  switch (def.dataType) {
    case "integer":
    case "decimal": {
      const n =
        def.dataType === "integer"
          ? INTEGER.test(raw)
            ? Number(raw)
            : undefined
          : parseDecimal(raw);
      if (n === undefined || !Number.isFinite(n)) {
        return statusInfo(
          REASON.invalidValue,
          `expected ${def.dataType === "integer" ? "an integer" : "a decimal number"}`,
        );
      }
      return checkRange(def, n);
    }
    case "boolean": {
      const lower = raw.trim().toLowerCase();
      return lower === "true" || lower === "false"
        ? undefined
        : statusInfo(REASON.invalidValue, "expected true or false");
    }
    case "OptionList":
      return def.valuesList === undefined || def.valuesList.includes(raw)
        ? undefined
        : statusInfo(
            REASON.invalidValue,
            `expected one of ${def.valuesList.join(", ")}`,
          );
    case "MemberList": {
      if (def.valuesList === undefined) return undefined;
      const members = raw.trim() === "" ? [] : raw.split(",");
      const bad = members.find((m) => !def.valuesList?.includes(m.trim()));
      return bad === undefined
        ? undefined
        : statusInfo(REASON.invalidValue, `${bad.trim()} is not a member`);
    }
    case "string":
      return undefined;
  }
}

/** `ValueOutOfRange` when `n` is outside the variable's min / max. */
export function checkRange(
  def: Pick<DeviceModelVariableDef, "min" | "max">,
  n: number,
): VariableStatusInfo | undefined {
  if (def.min !== undefined && n < def.min) {
    return statusInfo(REASON.valueOutOfRange, `below the minimum ${def.min}`);
  }
  if (def.max !== undefined && n > def.max) {
    return statusInfo(REASON.valueOutOfRange, `above the maximum ${def.max}`);
  }
  return undefined;
}
