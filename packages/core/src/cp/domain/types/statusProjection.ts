import { OCPP_1_2, OCPP_1_5 } from "./OcppVersion";
import type { OcppVersion } from "./OcppVersion";
import { OCPPStatus, type ChargePointErrorCode } from "./OcppTypes";

/**
 * ProjectedChargePointStatus: the union of all wire-protocol status vocabularies
 * across OCPP 1.2, 1.5, 1.6S, and 1.6J.
 *
 * - 1.2 uses: Available, Occupied, Unavailable, Faulted (no Reserved)
 * - 1.5 uses: Available, Occupied, Unavailable, Reserved, Faulted
 * - 1.6-SOAP and 1.6J use: Available, Preparing, Charging, SuspendedEV,
 *   SuspendedEVSE, Finishing, Reserved, Unavailable, Faulted
 *
 * This union encompasses all of them.
 */
export type ProjectedChargePointStatus =
  | "Available"
  | "Occupied"
  | "Preparing"
  | "Charging"
  | "SuspendedEV"
  | "SuspendedEVSE"
  | "Finishing"
  | "Reserved"
  | "Unavailable"
  | "Faulted";

/**
 * ProjectedChargePointErrorCode: the union of all wire-protocol error code
 * vocabularies across OCPP 1.2, 1.5, 1.6S, and 1.6J.
 *
 * - 1.2 uses: ConnectorLockFailure, HighTemperature, Mode3Error, NoError,
 *   PowerMeterFailure, PowerSwitchFailure, ReaderFailure, ResetFailure
 * - 1.5 uses: adds GroundFailure, OverCurrentFailure, UnderVoltage, WeakSignal, OtherError
 * - 1.6-SOAP and 1.6J use: all 1.5 + EVCommunicationError, InternalError, LocalListConflict, OverVoltage
 *
 * This union encompasses all of them.
 */
export type ProjectedChargePointErrorCode =
  | "ConnectorLockFailure"
  | "EVCommunicationError"
  | "GroundFailure"
  | "HighTemperature"
  | "InternalError"
  | "LocalListConflict"
  | "NoError"
  | "OtherError"
  | "OverCurrentFailure"
  | "OverVoltage"
  | "PowerMeterFailure"
  | "PowerSwitchFailure"
  | "ReaderFailure"
  | "ResetFailure"
  | "UnderVoltage"
  | "WeakSignal"
  | "Mode3Error";

/**
 * Project a domain OCPPStatus to the version-specific wire vocabulary.
 *
 * - OCPP-1.2: Narrow 4-value set (Available, Occupied, Unavailable, Faulted).
 *   Reserved → Unavailable; transaction-progress (Preparing/Charging/SuspendedEV/
 *   SuspendedEVSE/Finishing) → Occupied.
 * - OCPP-1.5: Narrow 5-value set (Available, Occupied, Unavailable, Reserved, Faulted).
 *   Transaction-progress → Occupied; Reserved stays.
 * - OCPP-1.6J, OCPP-1.6S, OCPP-2.0.1, OCPP-2.1: Identity passthrough (all 9 values).
 *
 * @param version The OCPP version
 * @param status The domain OCPPStatus
 * @returns The projected status for the wire protocol
 */
export function projectStatusForVersion(
  version: OcppVersion,
  status: OCPPStatus,
): ProjectedChargePointStatus {
  // OCPP 1.2: narrowest set (no Reserved)
  if (version === OCPP_1_2) {
    switch (status) {
      case OCPPStatus.Available:
        return "Available";
      case OCPPStatus.Faulted:
        return "Faulted";
      case OCPPStatus.Unavailable:
        return "Unavailable";
      case OCPPStatus.Reserved:
        // 1.2 has no Reserved; reserved connectors are not usable (Unavailable).
        return "Unavailable";
      case OCPPStatus.Preparing:
      case OCPPStatus.Charging:
      case OCPPStatus.SuspendedEV:
      case OCPPStatus.SuspendedEVSE:
      case OCPPStatus.Finishing:
        // 1.2 collapses transaction-progress states to Occupied.
        return "Occupied";
      default: {
        const exhaustive: never = status;
        return exhaustive;
      }
    }
  }

  // OCPP 1.5: narrow 5-value set (has Reserved)
  if (version === OCPP_1_5) {
    switch (status) {
      case OCPPStatus.Available:
        return "Available";
      case OCPPStatus.Faulted:
        return "Faulted";
      case OCPPStatus.Unavailable:
        return "Unavailable";
      case OCPPStatus.Reserved:
        return "Reserved";
      case OCPPStatus.Preparing:
      case OCPPStatus.Charging:
      case OCPPStatus.SuspendedEV:
      case OCPPStatus.SuspendedEVSE:
      case OCPPStatus.Finishing:
        // 1.5 collapses transaction-progress states to Occupied.
        return "Occupied";
      default: {
        const exhaustive: never = status;
        return exhaustive;
      }
    }
  }

  // OCPP 1.6J, OCPP-1.6S, OCPP-2.0.1, OCPP-2.1: identity passthrough (all 9 values)
  switch (status) {
    case OCPPStatus.Available:
      return "Available";
    case OCPPStatus.Preparing:
      return "Preparing";
    case OCPPStatus.Charging:
      return "Charging";
    case OCPPStatus.SuspendedEV:
      return "SuspendedEV";
    case OCPPStatus.SuspendedEVSE:
      return "SuspendedEVSE";
    case OCPPStatus.Finishing:
      return "Finishing";
    case OCPPStatus.Reserved:
      return "Reserved";
    case OCPPStatus.Unavailable:
      return "Unavailable";
    case OCPPStatus.Faulted:
      return "Faulted";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/**
 * Project a domain ChargePointErrorCode to the version-specific wire vocabulary.
 *
 * - OCPP-1.2: Narrow 8-value set. Codes with no 1.2 equivalent collapse to Mode3Error.
 * - OCPP-1.5: Narrow 13-value set. EVCommunicationError → Mode3Error;
 *   InternalError/LocalListConflict/OverVoltage → OtherError.
 * - OCPP-1.6J, OCPP-1.6S, OCPP-2.0.1, OCPP-2.1: Identity passthrough.
 *
 * @param version The OCPP version
 * @param errorCode The domain ChargePointErrorCode
 * @returns The projected error code for the wire protocol
 */
export function projectErrorCodeForVersion(
  version: OcppVersion,
  errorCode: ChargePointErrorCode,
): ProjectedChargePointErrorCode {
  // OCPP 1.2: narrowest set (8 values only)
  if (version === OCPP_1_2) {
    switch (errorCode) {
      case "ConnectorLockFailure":
      case "HighTemperature":
      case "NoError":
      case "PowerMeterFailure":
      case "PowerSwitchFailure":
      case "ReaderFailure":
      case "ResetFailure":
        return errorCode;
      case "EVCommunicationError":
        // 1.6 has EVCommunicationError; 1.2 uses Mode3Error (charging circuit fault).
        return "Mode3Error";
      case "GroundFailure":
      case "OverCurrentFailure":
      case "OverVoltage":
      case "UnderVoltage":
        // Electrical/charging faults → Mode3Error (closest in 1.2).
        return "Mode3Error";
      case "WeakSignal":
      case "OtherError":
      case "InternalError":
      case "LocalListConflict":
        // Generic/unknown → Mode3Error (no better bucket in 1.2).
        return "Mode3Error";
      default: {
        const exhaustive: never = errorCode;
        return exhaustive;
      }
    }
  }

  // OCPP 1.5: narrow 13-value set (no EVCommunicationError, InternalError, LocalListConflict, OverVoltage)
  if (version === OCPP_1_5) {
    switch (errorCode) {
      case "ConnectorLockFailure":
      case "HighTemperature":
      case "NoError":
      case "PowerMeterFailure":
      case "PowerSwitchFailure":
      case "ReaderFailure":
      case "ResetFailure":
      case "GroundFailure":
      case "OverCurrentFailure":
      case "UnderVoltage":
      case "WeakSignal":
      case "OtherError":
        return errorCode;
      case "EVCommunicationError":
        // OCPP 1.5 has no EVCommunicationError; Mode3Error is the closest
        // connector/EV communication fault in the 1.5 ChargePointErrorCode set.
        return "Mode3Error";
      case "InternalError":
      case "LocalListConflict":
      case "OverVoltage":
        return "OtherError";
      default: {
        const exhaustive: never = errorCode;
        return exhaustive;
      }
    }
  }

  // OCPP 1.6J, OCPP-1.6S, OCPP-2.0.1, OCPP-2.1: identity passthrough
  switch (errorCode) {
    case "ConnectorLockFailure":
    case "EVCommunicationError":
    case "GroundFailure":
    case "HighTemperature":
    case "InternalError":
    case "LocalListConflict":
    case "NoError":
    case "OtherError":
    case "OverCurrentFailure":
    case "OverVoltage":
    case "PowerMeterFailure":
    case "PowerSwitchFailure":
    case "ReaderFailure":
    case "ResetFailure":
    case "UnderVoltage":
    case "WeakSignal":
      return errorCode;
    default: {
      const exhaustive: never = errorCode;
      return exhaustive;
    }
  }
}
