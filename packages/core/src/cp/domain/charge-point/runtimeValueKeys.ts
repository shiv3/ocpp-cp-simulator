import { OCPPStatus } from "../types/OcppTypes";

/**
 * Configuration keys of the runtime values a 2.x station publishes as
 * device-model variables (#538), so GetVariables reads them and variable
 * monitors watch them. Read-only, never persisted, 2.x only. A per-EVSE
 * value's key is {@link evseValueKey} of its prefix (EVSE N is connector N).
 */
export const RUNTIME_VALUE_KEYS = {
  /** `EVSE.Power`: instantaneous active power in W, prefix of a per-EVSE key. */
  evsePower: "EVSEPower",
  /** `EVSE.AvailabilityState`, prefix of a per-EVSE key. */
  evseState: "EVSEAvailabilityState",
  /** `Connector.AvailabilityState` (connector 1 of the EVSE), prefix. */
  connectorState: "ConnectorAvailabilityState",
  /** `ChargingStation.AvailabilityState`. */
  chargingStationAvailabilityState: "ChargingStationAvailabilityState",
} as const;

export function evseValueKey(prefix: string, evseId: number): string {
  return `${prefix}${evseId}`;
}

/**
 * `ConnectorStatusEnumType`, the values of an `AvailabilityState` variable:
 * it "replicates ConnectorStatus values reported in StatusNotification
 * messages" (Part 2 appendices, variables).
 */
export const V2_CONNECTOR_STATUSES = [
  "Available",
  "Occupied",
  "Reserved",
  "Unavailable",
  "Faulted",
] as const;

export type V2ConnectorStatus = (typeof V2_CONNECTOR_STATUSES)[number];

/** The 2.x connector status a 1.6-style status is reported as. */
export function toV2ConnectorStatus(status: OCPPStatus): V2ConnectorStatus {
  switch (status) {
    case OCPPStatus.Available:
      return "Available";
    case OCPPStatus.Reserved:
      return "Reserved";
    case OCPPStatus.Unavailable:
      return "Unavailable";
    case OCPPStatus.Faulted:
      return "Faulted";
    default:
      return "Occupied";
  }
}
