import {
  OCPPErrorCodeV16,
  OCPPErrorCodeV201,
} from "@ocpp-cp-simulator/ocpp/enums";
import type { ViolationKind } from "./violationKind";

/**
 * What one OCPP-J version speaks: its error codes and whether it has the
 * OCPP 2.1 message types. The versions spell the codes differently (1.6
 * `FormationViolation` / `OccurenceConstraintViolation`, 2.x
 * `FormatViolation` / `OccurrenceConstraintViolation`), so each version gets
 * its own table rather than one code list for all.
 */
export interface RpcDialect<Code extends string = string> {
  /** The error code for each kind of payload violation (OCPP-J 1.6 §4.2.3,
   *  2.0.1 / 2.1 Part 4 §4.3 Table 8). */
  readonly violationCodes: Readonly<Record<ViolationKind, Code>>;
  /** Answer to a CALL whose action has no handler. */
  readonly notImplemented: Code;
  /** Answer to a CALL whose handler failed. */
  readonly internalError: Code;
  /** Whether CALLRESULTERROR (5) and SEND (6) exist: OCPP 2.1 only (Part 4
   *  §4.1.3). Elsewhere they are an unknown message type. */
  readonly ocpp21MessageTypes: boolean;
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
  ocpp21MessageTypes: false,
};

/** OCPP 2.0.1. OCPP 2.1 shares its error codes, see `OCPP21_RPC_DIALECT`. */
export const OCPP2X_RPC_DIALECT: RpcDialect<OCPPErrorCodeV201> = {
  violationCodes: {
    format: OCPPErrorCodeV201.FormatViolation,
    occurrence: OCPPErrorCodeV201.OccurrenceConstraintViolation,
    type: OCPPErrorCodeV201.TypeConstraintViolation,
    property: OCPPErrorCodeV201.PropertyConstraintViolation,
  },
  notImplemented: OCPPErrorCodeV201.NotImplemented,
  internalError: OCPPErrorCodeV201.InternalError,
  ocpp21MessageTypes: false,
};

/** OCPP 2.1: the 2.0.1 error codes, plus CALLRESULTERROR and SEND. */
export const OCPP21_RPC_DIALECT: RpcDialect<OCPPErrorCodeV201> = {
  ...OCPP2X_RPC_DIALECT,
  ocpp21MessageTypes: true,
};
