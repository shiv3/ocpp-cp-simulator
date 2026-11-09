import { OCPPStatus } from "../types/OcppTypes";

/**
 * The status transitions OCPP 1.6 (edition 2, section 4.9, "The following
 * table describes which status transitions are possible") allows between two
 * statuses of a connector with `connectorId > 0`: 53 of the 72 ordered pairs.
 * The cell letters and numbers (A2, B6, ...) are the spec's own: row = the
 * status transitioned from, column = the status transitioned to, numbered in
 * the order Available 1, Preparing 2, Charging 3, SuspendedEV 4,
 * SuspendedEVSE 5, Finishing 6, Reserved 7, Unavailable 8, Faulted 9.
 *
 * Exported so UI controls offer what the charger expects. The charger engine
 * checks every `updateConnectorStatus` against it and only logs a warning when
 * a transition is not listed: scenarios and tests may force any status.
 *
 * Notes from the spec and its errata (v3.0, v4.0):
 * - B6 (Preparing to Finishing) was added by errata v3.0: a connection that
 *   times out without an idTag goes to Finishing, not Available, so a second
 *   driver cannot start a transaction on the plugged-in cable.
 * - I1-I8: a fault that is resolved returns to the pre-fault status, so
 *   Faulted may lead to every status but itself.
 * - Preparing to Unavailable is not in the table.
 * - For `connectorId` 0 only Available, Unavailable and Faulted apply; this
 *   table is not meant for it.
 */
export const ALLOWED_CONNECTOR_STATUS_TRANSITIONS: Readonly<
  Record<OCPPStatus, ReadonlyArray<OCPPStatus>>
> = {
  // A2 A3 A4 A5 A7 A8 A9
  [OCPPStatus.Available]: [
    OCPPStatus.Preparing,
    OCPPStatus.Charging,
    OCPPStatus.SuspendedEV,
    OCPPStatus.SuspendedEVSE,
    OCPPStatus.Reserved,
    OCPPStatus.Unavailable,
    OCPPStatus.Faulted,
  ],
  // B1 B3 B4 B5 B6 B9
  [OCPPStatus.Preparing]: [
    OCPPStatus.Available,
    OCPPStatus.Charging,
    OCPPStatus.SuspendedEV,
    OCPPStatus.SuspendedEVSE,
    OCPPStatus.Finishing,
    OCPPStatus.Faulted,
  ],
  // C1 C4 C5 C6 C8 C9
  [OCPPStatus.Charging]: [
    OCPPStatus.Available,
    OCPPStatus.SuspendedEV,
    OCPPStatus.SuspendedEVSE,
    OCPPStatus.Finishing,
    OCPPStatus.Unavailable,
    OCPPStatus.Faulted,
  ],
  // D1 D3 D5 D6 D8 D9
  [OCPPStatus.SuspendedEV]: [
    OCPPStatus.Available,
    OCPPStatus.Charging,
    OCPPStatus.SuspendedEVSE,
    OCPPStatus.Finishing,
    OCPPStatus.Unavailable,
    OCPPStatus.Faulted,
  ],
  // E1 E3 E4 E6 E8 E9
  [OCPPStatus.SuspendedEVSE]: [
    OCPPStatus.Available,
    OCPPStatus.Charging,
    OCPPStatus.SuspendedEV,
    OCPPStatus.Finishing,
    OCPPStatus.Unavailable,
    OCPPStatus.Faulted,
  ],
  // F1 F2 F8 F9
  [OCPPStatus.Finishing]: [
    OCPPStatus.Available,
    OCPPStatus.Preparing,
    OCPPStatus.Unavailable,
    OCPPStatus.Faulted,
  ],
  // G1 G2 G8 G9
  [OCPPStatus.Reserved]: [
    OCPPStatus.Available,
    OCPPStatus.Preparing,
    OCPPStatus.Unavailable,
    OCPPStatus.Faulted,
  ],
  // H1 H2 H3 H4 H5 H9
  [OCPPStatus.Unavailable]: [
    OCPPStatus.Available,
    OCPPStatus.Preparing,
    OCPPStatus.Charging,
    OCPPStatus.SuspendedEV,
    OCPPStatus.SuspendedEVSE,
    OCPPStatus.Faulted,
  ],
  // I1-I8: back to the pre-fault status
  [OCPPStatus.Faulted]: [
    OCPPStatus.Available,
    OCPPStatus.Preparing,
    OCPPStatus.Charging,
    OCPPStatus.SuspendedEV,
    OCPPStatus.SuspendedEVSE,
    OCPPStatus.Finishing,
    OCPPStatus.Reserved,
    OCPPStatus.Unavailable,
  ],
};

export function isAllowedConnectorStatusTransition(
  from: OCPPStatus,
  to: OCPPStatus,
): boolean {
  return from === to || ALLOWED_CONNECTOR_STATUS_TRANSITIONS[from].includes(to);
}
