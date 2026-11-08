import { OCPPStatus } from "../types/OcppTypes";

/**
 * Allowed next OCPP statuses for operator-driven status changes, exported so
 * UI controls offer what the charger expects. The charger engine checks every
 * `updateConnectorStatus` against it and only logs a warning when a transition
 * is not listed: scenarios and tests may force any status.
 */
export const ALLOWED_CONNECTOR_STATUS_TRANSITIONS: Readonly<
  Record<OCPPStatus, ReadonlyArray<OCPPStatus>>
> = {
  [OCPPStatus.Available]: [
    OCPPStatus.Preparing,
    OCPPStatus.Reserved,
    OCPPStatus.Unavailable,
    OCPPStatus.Faulted,
  ],
  [OCPPStatus.Preparing]: [
    OCPPStatus.Charging,
    OCPPStatus.SuspendedEVSE,
    OCPPStatus.Available,
    OCPPStatus.Unavailable,
    OCPPStatus.Faulted,
  ],
  [OCPPStatus.Charging]: [
    OCPPStatus.SuspendedEV,
    OCPPStatus.SuspendedEVSE,
    OCPPStatus.Finishing,
    OCPPStatus.Unavailable,
    OCPPStatus.Faulted,
  ],
  [OCPPStatus.SuspendedEV]: [
    OCPPStatus.Charging,
    OCPPStatus.SuspendedEVSE,
    OCPPStatus.Finishing,
    OCPPStatus.Faulted,
  ],
  [OCPPStatus.SuspendedEVSE]: [
    OCPPStatus.Charging,
    OCPPStatus.SuspendedEV,
    OCPPStatus.Finishing,
    OCPPStatus.Faulted,
  ],
  [OCPPStatus.Finishing]: [
    OCPPStatus.Available,
    OCPPStatus.Unavailable,
    OCPPStatus.Faulted,
  ],
  [OCPPStatus.Reserved]: [
    OCPPStatus.Preparing,
    OCPPStatus.Available,
    OCPPStatus.Unavailable,
    OCPPStatus.Faulted,
  ],
  [OCPPStatus.Unavailable]: [OCPPStatus.Available, OCPPStatus.Faulted],
  [OCPPStatus.Faulted]: [OCPPStatus.Available, OCPPStatus.Unavailable],
};

export function isAllowedConnectorStatusTransition(
  from: OCPPStatus,
  to: OCPPStatus,
): boolean {
  return from === to || ALLOWED_CONNECTOR_STATUS_TRANSITIONS[from].includes(to);
}
