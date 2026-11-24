import { schemas } from "@ocpp-cp-simulator/ocpp";
import {
  strictValidationIssues,
  validateOCPPPayload,
} from "@ocpp-cp-simulator/ocpp/validation";
import { violationKind, type ViolationKind } from "./violationKind";

/** What the endpoint validates: an inbound CALL's or SEND's request, or an
 *  inbound CALLRESULT's response, for the action of the CALL. */
export interface RpcValidationTarget {
  readonly direction: "request" | "response";
  readonly action: string;
  readonly payload: unknown;
}

/** A payload the validator refused: the kind decides the error code, through
 *  the endpoint's dialect. */
export interface RpcViolation {
  readonly kind: ViolationKind;
  /** At most 255 characters (2.x ErrorDescription is string[255]). */
  readonly description: string;
}

/** Returns null for a payload it accepts or cannot judge. */
export type RpcValidator = (target: RpcValidationTarget) => RpcViolation | null;

export type OcppSchemaVersion = "1.6" | "2.0.1" | "2.1";

const SCHEMA_SETS: Record<
  OcppSchemaVersion,
  { set: Record<string, object>; suffix: string }
> = {
  "1.6": { set: schemas.v16, suffix: "V16" },
  "2.0.1": { set: schemas.v201, suffix: "V201" },
  "2.1": { set: schemas.v21, suffix: "V21" },
};

/**
 * A validator over the OCA JSON schemas bundled in `@ocpp-cp-simulator/ocpp`.
 * An action with no schema for `version` is let through: a CALL for an
 * unknown action is answered by the missing handler (NotImplemented), not by
 * the validator.
 *
 * Admission uses the lenient check (`validateOCPPPayload`, no `format`
 * keywords), so a 1.6 `expiryDate: "not-a-date"` reaches the handler; the
 * strict issues only name the violation of a payload already refused. This is
 * deliberate for now: the simulator itself mixes the two (strict for 1.6
 * requests since #285, lenient admission for 2.x requests, warn-only for
 * responses), and the rule for this package is settled when its inbound
 * dispatch moves here (#1059), rather than adding a third behaviour.
 */
export function ocppSchemaValidator(version: OcppSchemaVersion): RpcValidator {
  const { set, suffix } = SCHEMA_SETS[version];
  return ({ direction, action, payload }) => {
    const key = `${action.charAt(0).toLowerCase()}${action.slice(1)}${
      direction === "request" ? "Request" : "Response"
    }${suffix}`;
    const schema = set[key];
    if (!schema || validateOCPPPayload(schema, payload)) return null;
    let issues: ReturnType<typeof strictValidationIssues> = [];
    try {
      issues = strictValidationIssues(schema, payload);
    } catch {
      // A schema the strict compiler refuses: still invalid, as a format
      // violation (what an empty issue list means).
    }
    const detail = issues.map((issue) => issue.message).join("; ");
    return {
      kind: violationKind(issues),
      description: (detail
        ? `Invalid ${action} ${direction}: ${detail}`
        : `Invalid ${action} ${direction}`
      ).slice(0, 255),
    };
  };
}
