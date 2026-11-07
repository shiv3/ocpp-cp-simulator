import { schemas, validationErrors } from "@ocpp-cp-sim/ocpp/index";
import { isOcpp2Version } from "../../domain/types/OcppVersion";

/**
 * Check a response a behavior produced against the bundled JSON schema of
 * `action`'s response. Returns the problems, or `[]` when it is valid or when
 * no schema is bundled for the action (nothing to check against).
 */
export function responseProblems(
  action: string,
  ocppVersion: string,
  response: unknown,
): string[] {
  const suffix =
    ocppVersion === "OCPP-2.1"
      ? "V21"
      : isOcpp2Version(ocppVersion)
        ? "V201"
        : "V16";
  const table =
    suffix === "V21"
      ? schemas.v21
      : suffix === "V201"
        ? schemas.v201
        : schemas.v16;
  const key = `${action.charAt(0).toLowerCase()}${action.slice(1)}Response${suffix}`;
  const schema = (table as Record<string, unknown>)[key];
  if (schema === undefined) return [];
  return validationErrors(schema as object, response);
}
