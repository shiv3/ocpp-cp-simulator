import { isOneOf } from "@ocpp-cp-simulator/core/cp/domain/types/FirmwareLogStatus";

/**
 * Parameter readers of the JSON command surface (`jsonMode.ts`): each throws
 * the "Missing or invalid parameter" error a caller sees on a bad command.
 */

export function requirePositiveInt(
  params: Record<string, unknown>,
  key: string,
): number {
  const val = params[key];
  if (typeof val !== "number" || !Number.isInteger(val) || val < 1) {
    throw new Error(
      `Missing or invalid parameter: ${key} (expected positive integer)`,
    );
  }
  return val;
}

export function requireNonNegativeInt(
  params: Record<string, unknown>,
  key: string,
): number {
  const val = params[key];
  if (typeof val !== "number" || !Number.isInteger(val) || val < 0) {
    throw new Error(
      `Missing or invalid parameter: ${key} (expected non-negative integer)`,
    );
  }
  return val;
}

/** A number parameter that may be absent, but must be finite and >= 0 when present. */
export function optionalNonNegativeNumber(
  params: Record<string, unknown>,
  key: string,
): number | undefined {
  const val = params[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== "number" || !Number.isFinite(val) || val < 0) {
    throw new Error(
      `Invalid parameter: ${key} (expected a non-negative number)`,
    );
  }
  return val;
}

export function requireNumber(
  params: Record<string, unknown>,
  key: string,
): number {
  const val = params[key];
  if (typeof val !== "number" || isNaN(val)) {
    throw new Error(`Missing or invalid parameter: ${key} (expected number)`);
  }
  return val;
}

/**
 * A string parameter that may be absent, but must be a non-empty string when
 * present. Used where the domain has its own fallback — `tagId`, which a
 * charge point with an idTag pool fills in itself (#299).
 */
export function optionalString(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const val = params[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== "string" || val.length === 0) {
    throw new Error(`Invalid parameter: ${key} (expected non-empty string)`);
  }
  return val;
}

export function requireString(
  params: Record<string, unknown>,
  key: string,
): string {
  const val = params[key];
  if (typeof val !== "string" || val.length === 0) {
    throw new Error(`Missing or invalid parameter: ${key} (expected string)`);
  }
  return val;
}

/**
 * A string parameter that must be one of `allowed` when present. The error
 * names the vocabulary so a caller who misspelt an OCPP enum value sees the
 * spelling that would have worked (#335).
 */
export function optionalEnum<T extends string>(
  params: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const val = params[key];
  if (val === undefined || val === null) return undefined;
  if (!isOneOf(val, allowed)) {
    throw new Error(
      `Invalid parameter: ${key} (expected one of ${allowed.join(", ")})`,
    );
  }
  return val;
}

export function requireEnum<T extends string>(
  params: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  const val = optionalEnum(params, key, allowed);
  if (val === undefined) {
    throw new Error(
      `Missing or invalid parameter: ${key} (expected one of ${allowed.join(", ")})`,
    );
  }
  return val;
}

export function optionalBoolean(
  params: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const val = params[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== "boolean") {
    throw new Error(`Invalid parameter: ${key} (expected boolean)`);
  }
  return val;
}

export function requireBoolean(
  params: Record<string, unknown>,
  key: string,
): boolean {
  const val = params[key];
  if (typeof val !== "boolean") {
    throw new Error(`Missing or invalid parameter: ${key} (expected boolean)`);
  }
  return val;
}

export function requireObject(
  params: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const val = params[key];
  if (typeof val !== "object" || val === null || Array.isArray(val)) {
    throw new Error(`Missing or invalid parameter: ${key} (expected object)`);
  }
  return val as Record<string, unknown>;
}
