import type { ChargePoint } from "../charge-point/ChargePoint";
import { OCPPStatus, ReservationStatus } from "../types/OcppTypes";
import { isOcpp2Version } from "../types/OcppVersion";

/**
 * The reservation model both OCPP versions share (#595, #709-#712, #721,
 * #731): which connectors can still take a reservation or a session, the
 * capacity rule that keeps one connector for each reservation that names none,
 * and the status the connectors show for them. The spec clauses agree where
 * this module is shared: 1.6 §5.13 and 2.0.1 H01.FR.04/07/18/19/20.
 */

/**
 * Whether the station takes a reservation that names no connector: 1.6
 * `ReserveConnectorZeroSupported`, 2.x `ReservationCtrlr.NonEvseSpecific`
 * (one value, two names; H01.FR.18/19). Unset means false.
 */
export function unspecifiedReservationsSupported(cp: ChargePoint): boolean {
  return cp.configuration.getBoolean("ReserveConnectorZeroSupported") === true;
}

/** Connectors that can still take a reservation or a session right now. */
function freeConnectors(cp: ChargePoint) {
  const two = isOcpp2Version(cp.ocppVersion);
  return [...cp.connectors.values()].filter(
    (c) =>
      c.id !== 0 &&
      c.status !== OCPPStatus.Faulted &&
      c.availability === "Operative" &&
      !c.transaction &&
      // 2.x counts EVSEs that are Available (H01.FR.04); a Reserved one is
      // kept for a reservation without a connector, so it is still free.
      (two
        ? c.status === OCPPStatus.Available || c.status === OCPPStatus.Reserved
        : c.status !== OCPPStatus.Charging),
  );
}

/**
 * The capacity rule of 1.6 §5.13 / 2.0.1 H01.FR.07, shared by ReserveNow and
 * the start of a session so both count the same way: the connectors that can
 * still take a session, other than `takenConnectorId` and those holding their
 * own reservation, less one per reservation that names no connector
 * (`ignoreReservationId`, the reservation a ReserveNow replaces, is left out).
 * A negative result means those reservations no longer have a connector each.
 */
export function connectorCapacityShortfall(
  cp: ChargePoint,
  takenConnectorId: number,
  ignoreReservationId?: number,
): number {
  const held = cp.reservationManager
    .getAllReservations()
    .filter((r) => r.reservationId !== ignoreReservationId);
  const owned = new Set(
    held.filter((r) => r.connectorId !== 0).map((r) => r.connectorId),
  );
  const zero = held.filter((r) => r.connectorId === 0).length;
  const spare = freeConnectors(cp).filter(
    (c) => !owned.has(c.id) && c.id !== takenConnectorId,
  ).length;
  return spare - zero;
}

/**
 * Why a session of `idTag` on `connectorId` must be refused because of a
 * reservation, or `null` when it may go ahead (OCPP 1.6 §5.13: "SHALL refuse
 * charging for all incoming idTags on the reserved connector" except the
 * reserved one; 2.0.1 H03.FR.01/04/09). `parentOfTag` is the tag's parent id
 * or groupIdToken, when the station knows it.
 *
 * - `reservedForOther`: the connector holds a reservation that does not admit
 *   the tag; the reservation stays and the session does not start (#721,
 *   #711).
 * - `noConnectorLeft`: the session would take the last connector a
 *   reservation without a connector keeps for its owner (§5.13: "one connector
 *   remains available for the reserved idTag", H01.FR.07).
 */
export function startRefusalByReservation(
  cp: ChargePoint,
  connectorId: number,
  idTag: string,
  parentOfTag?: string,
): "reservedForOther" | "noConnectorLeft" | null {
  const manager = cp.reservationManager;
  if (manager.reservationFor(connectorId, idTag, parentOfTag)) return null;
  if (manager.reservationOn(connectorId)) return "reservedForOther";
  return connectorCapacityShortfall(cp, connectorId) < 0
    ? "noConnectorLeft"
    : null;
}

/**
 * Why a ReserveNow cannot be accepted, or `null` when the station can take it.
 * `connectorId` 0 is a reservation that names no connector (1.6 connector 0,
 * 2.x without `evseId`). Everything here depends on the station only (the
 * reservation manager's own checks, an expired date or a taken connector, come
 * after), so a caller can run it before it spends an Authorize.req on the tag.
 *
 * Capacity (#595, H01.FR.04): the station keeps one connector available for
 * each reservation. With `free` the connectors that can still take a session,
 * `specific` those among them that hold their own reservation and `zero` the
 * reservations without a connector (the one this ReserveNow replaces is left
 * out of both), a ReserveNow without a connector needs
 * `free − specific − zero ≥ 1`, and one for connector `n` needs the connectors
 * other than `n` to still cover `zero`. Otherwise the answer is `Occupied`.
 *
 * A specific 2.x EVSE is `Occupied` whenever its status is not Available
 * (H01.FR.11: Reserved or Occupied, which on the wire covers a plugged cable
 * with no transaction too), unless it is Reserved by the very reservation this
 * ReserveNow replaces (H01.FR.02). 1.6 answers Occupied for Preparing,
 * Charging, SuspendedEV, SuspendedEVSE and Finishing (§5.13, §4.9) or a
 * transaction.
 */
export function reserveNowRefusal(
  cp: ChargePoint,
  connectorId: number,
  reservationId: number,
): ReservationStatus | null {
  if (connectorId === 0 && !unspecifiedReservationsSupported(cp)) {
    return ReservationStatus.Rejected;
  }
  if (connectorId !== 0) {
    const connector = cp.getConnector(connectorId);
    if (!connector) return ReservationStatus.Rejected;
    if (connector.status === OCPPStatus.Faulted) {
      return ReservationStatus.Faulted;
    }
    // 1.6 §5.13: Occupied when the connector is occupied, which §4.9 defines
    // as Preparing, Charging, SuspendedEV, SuspendedEVSE or Finishing (the
    // status table has no Preparing → Reserved transition). A plugged-in
    // connector is Preparing since #453.
    if (
      !isOcpp2Version(cp.ocppVersion) &&
      (connector.status === OCPPStatus.Preparing ||
        connector.status === OCPPStatus.SuspendedEV ||
        connector.status === OCPPStatus.SuspendedEVSE ||
        connector.status === OCPPStatus.Finishing)
    ) {
      return ReservationStatus.Occupied;
    }
    if (connector.status === OCPPStatus.Charging || connector.transaction) {
      return ReservationStatus.Occupied;
    }
    if (connector.availability !== "Operative") {
      return ReservationStatus.Unavailable;
    }
    if (isOcpp2Version(cp.ocppVersion)) {
      if (connector.status === OCPPStatus.Unavailable) {
        return ReservationStatus.Unavailable;
      }
      const ownReplaced =
        connector.status === OCPPStatus.Reserved &&
        cp.reservationManager.reservationOn(connectorId)?.reservationId ===
          reservationId;
      if (connector.status !== OCPPStatus.Available && !ownReplaced) {
        return ReservationStatus.Occupied;
      }
    }
  } else {
    const connectors = [...cp.connectors.values()].filter((c) => c.id !== 0);
    if (
      connectors.length > 0 &&
      connectors.every((c) => c.status === OCPPStatus.Faulted)
    ) {
      return ReservationStatus.Faulted;
    }
    const usable = connectors.filter((c) => c.status !== OCPPStatus.Faulted);
    if (
      usable.length > 0 &&
      usable.every((c) => c.availability !== "Operative")
    ) {
      return ReservationStatus.Unavailable;
    }
  }

  // A reservation without a connector needs one of the spare connectors; a
  // specific reservation takes its own connector and leaves the rest to
  // `zero`.
  if (
    connectorCapacityShortfall(cp, connectorId, reservationId) <
    (connectorId === 0 ? 1 : 0)
  ) {
    return ReservationStatus.Occupied;
  }
  return null;
}

/** Stations being synced, and the connectors each marked Reserved itself. */
const syncing = new WeakSet<ChargePoint>();
const markedReserved = new WeakMap<ChargePoint, Set<number>>();

/**
 * OCPP 2.x H01.FR.20: the reservations without an EVSE show on the wire only
 * when they use up the free EVSEs. While there are as many such reservations
 * as EVSEs that are Available (and not reserved for themselves), every one of
 * those EVSEs reports Reserved; as soon as an EVSE is free for anyone again,
 * the EVSEs this marked go back to Available. Run after every change of a
 * reservation or a connector status; it settles (the second run changes
 * nothing). OCPP 1.6 leaves the connectors' status alone for a connector-0
 * reservation (#595), so this does nothing there.
 */
export function syncUnspecifiedReservations(cp: ChargePoint): void {
  if (!isOcpp2Version(cp.ocppVersion) || syncing.has(cp)) return;
  syncing.add(cp);
  try {
    const held = cp.reservationManager.getAllReservations();
    const owned = new Set(
      held.filter((r) => r.connectorId !== 0).map((r) => r.connectorId),
    );
    const zero = held.filter((r) => r.connectorId === 0).length;
    const pool = freeConnectors(cp).filter((c) => !owned.has(c.id));
    const marked = markedReserved.get(cp) ?? new Set<number>();
    markedReserved.set(cp, marked);

    if (zero > 0 && pool.length <= zero) {
      for (const connector of pool) {
        if (connector.status === OCPPStatus.Available) {
          cp.updateConnectorStatus(connector.id, OCPPStatus.Reserved);
        }
        if (connector.status === OCPPStatus.Reserved) marked.add(connector.id);
      }
      return;
    }
    for (const id of [...marked]) {
      marked.delete(id);
      const connector = cp.getConnector(id);
      if (
        connector &&
        connector.status === OCPPStatus.Reserved &&
        !owned.has(id)
      ) {
        cp.updateConnectorStatus(id, cp.statusWhenFree(id));
      }
    }
  } finally {
    syncing.delete(cp);
  }
}
