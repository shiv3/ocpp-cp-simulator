import {
  OCPPErrorCodeV16,
  OCPPErrorCodeV201,
} from "@ocpp-cp-simulator/ocpp/enums";
import type { ViolationKind } from "./violationKind";

/**
 * The error codes one OCPP-J version answers with. The versions spell them
 * differently (1.6 `FormationViolation` / `OccurenceConstraintViolation`,
 * 2.x `FormatViolation` / `OccurrenceConstraintViolation`), so each version
 * gets its own table rather than one code list for all.
 */
export interface RpcDialect<Code extends string = string> {
  /** The error code for each kind of payload violation (OCPP-J 1.6 §4.2.3,
   *  2.0.1 / 2.1 Part 4 §4.3 Table 8). */
  readonly violationCodes: Readonly<Record<ViolationKind, Code>>;
  /** Answer to a CALL whose action has no handler. */
  readonly notImplemented: Code;
  /** Answer to a CALL whose handler failed. */
  readonly internalError: Code;
}

export const OCPP16_RPC_DIALECT: RpcDialect<OCPPErrorCodeV16> = {
  violationCodes: {
    format: OCPPErrorCodeV16.FormationViolation,
    occurrence: OCPPErrorCodeV16.OccurenceConstraintViolation,
    type: OCPPErrorCodeV16.TypeConstraintViolation,
    property: OCPPErrorCodeV16.PropertyConstraintViolation,
  },
  notImplemented: OCPPErrorCodeV16.NotImplemented,
  internalError: OCPPErrorCodeV16.InternalError,
};

/** OCPP 2.0.1 and 2.1 share their RPC error codes. */
export const OCPP2X_RPC_DIALECT: RpcDialect<OCPPErrorCodeV201> = {
  violationCodes: {
    format: OCPPErrorCodeV201.FormatViolation,
    occurrence: OCPPErrorCodeV201.OccurrenceConstraintViolation,
    type: OCPPErrorCodeV201.TypeConstraintViolation,
    property: OCPPErrorCodeV201.PropertyConstraintViolation,
  },
  notImplemented: OCPPErrorCodeV201.NotImplemented,
  internalError: OCPPErrorCodeV201.InternalError,
};
