import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import {
  CancelReservationStatus,
  OCPPStatus,
  ReservationStatus,
} from "../../../domain/types/OcppTypes";
import { isOcpp2Version } from "../../../domain/types/OcppVersion";

export interface ReserveNow16Request {
  connectorId: number;
  expiryDate: string;
  idTag: string;
  parentIdTag?: string;
  reservationId: number;
}

interface ReserveNow2Request {
  id: number;
  evseId?: number;
  expiryDateTime: string;
  idToken: { idToken: string };
  groupIdToken?: { idToken: string };
}

interface CancelReservationRequest {
  reservationId: number;
}

/**
 * The default behaviors of ReserveNow and CancelReservation, over the
 * station's `ReservationManager`.
 *
 * ReserveNow answers `Rejected` for an unknown connector, `Faulted`,
 * `Occupied` (charging or a transaction in flight) or `Unavailable` (not
 * operative) before it asks the manager; an accepted reservation drives the
 * connector to `Reserved` through `updateConnectorStatus`, so the CSMS sees
 * the StatusNotification. CancelReservation answers `Accepted` for a known
 * reservation and, if its connector is still `Reserved`, drives it back to
 * `Available`.
 *
 * OCPP 1.6 changes the connector while it builds the answer, 2.x once the
 * answer settled.
 *
 * Two 1.6 rules (#595). A ReserveNow whose `reservationId` is already held
 * replaces that reservation (ReserveNow.req: "If a reservation with the same
 * `reservationId` exists, it is replaced"); when the old one sat on another
 * connector, that connector goes back to `Available`. `connectorId` 0 means
 * "any connector": it is accepted only when `ReserveConnectorZeroSupported`
 * is true (else `Rejected`) and leaves every connector's status alone. A
 * connector-0 reservation belongs to its `idTag` / `parentIdTag`: only that
 * tag's session consumes it. The station keeps one connector available for
 * each reservation, so a ReserveNow (connector 0 or specific) is `Occupied`
 * when the free connectors, less those with their own reservation and less
 * one per connector-0 reservation, cannot take it ({@link reserveNowRefusal16}),
 * and for the whole validity of a connector-0 reservation a session of another
 * tag that would take the last such connector is refused
 * ({@link startBlockedByReservation16}): RemoteStartTransaction answers
 * `Rejected`, a local start does not start (no StartTransaction.req).
 */
export function reservationBehavior(cp: ChargePoint): Behavior {
  return {
    api: 1,
    id: "default.reservation",
    onCall: {
      ReserveNow: {
        mode: "replace",
        handle: (request) => {
          const two = isOcpp2Version(cp.ocppVersion);
          const req = request as ReserveNow16Request & ReserveNow2Request;
          const connectorId = two ? (req.evseId ?? 1) : req.connectorId;
          if (!two) {
            const refusal = reserveNowRefusal16(cp, req);
            if (refusal) return { response: { status: refusal } };
            if (connectorId === 0) return acceptAnyConnector(cp, req);
          } else {
            const connector = cp.getConnector(connectorId);
            if (!connector) {
              return { response: { status: ReservationStatus.Rejected } };
            }
            if (connector.status === OCPPStatus.Faulted) {
              return { response: { status: ReservationStatus.Faulted } };
            }
            if (
              connector.status === OCPPStatus.Charging ||
              connector.transaction
            ) {
              return { response: { status: ReservationStatus.Occupied } };
            }
            if (connector.availability !== "Operative") {
              return { response: { status: ReservationStatus.Unavailable } };
            }
          }
          const connector = cp.getConnector(connectorId)!;
          const replaced = two
            ? undefined
            : cp.reservationManager.getReservation(req.reservationId);

          const status = two
            ? cp.reservationManager.createReservation(
                connectorId,
                new Date(req.expiryDateTime),
                req.idToken.idToken,
                req.groupIdToken?.idToken,
                req.id,
              )
            : cp.reservationManager.createReservation(
                connectorId,
                new Date(req.expiryDate),
                req.idTag,
                req.parentIdTag,
                req.reservationId,
                { replaceExisting: true, shareAnyConnector: true },
              );
          const reserve = (): void =>
            cp.updateConnectorStatus(connectorId, OCPPStatus.Reserved);
          if (status !== ReservationStatus.Accepted) {
            return { response: { status } };
          }
          if (two) {
            return {
              response: { status },
              after: async () => reserve(),
            };
          }
          // A bare `connector.status = …` fires only the connector-local
          // event and the CSMS never sees the transition, hence
          // `updateConnectorStatus`.
          if (replaced && replaced.connectorId !== connectorId) {
            releaseIfUnreserved(cp, replaced.connectorId);
          }
          if (connector.status !== OCPPStatus.Reserved) reserve();
          return { response: { status } };
        },
      },
      CancelReservation: {
        mode: "replace",
        handle: (request) => {
          const { reservationId } = request as CancelReservationRequest;
          const manager = cp.reservationManager;
          const reservation = manager.getReservation(reservationId);
          const cancelled = manager.cancelReservation(reservationId);
          if (!cancelled || !reservation) {
            return { response: { status: CancelReservationStatus.Rejected } };
          }
          const release = (): void => {
            const connector = cp.getConnector(reservation.connectorId);
            if (connector && connector.status === OCPPStatus.Reserved) {
              cp.updateConnectorStatus(
                reservation.connectorId,
                OCPPStatus.Available,
              );
            }
          };
          if (isOcpp2Version(cp.ocppVersion)) {
            return {
              response: { status: CancelReservationStatus.Accepted },
              after: async () => release(),
            };
          }
          release();
          return { response: { status: CancelReservationStatus.Accepted } };
        },
      },
    },
  };
}

/** A connector that shows `Reserved` but no longer holds a reservation goes back to `Available`. */
function releaseIfUnreserved(cp: ChargePoint, connectorId: number): void {
  const connector = cp.getConnector(connectorId);
  if (
    connector &&
    connector.status === OCPPStatus.Reserved &&
    !cp.reservationManager.hasReservationOn(connectorId)
  ) {
    cp.updateConnectorStatus(connectorId, OCPPStatus.Available);
  }
}

/** Connectors that can still take a reservation or a session right now. */
function freeConnectors(cp: ChargePoint) {
  return [...cp.connectors.values()].filter(
    (c) =>
      c.id !== 0 &&
      c.status !== OCPPStatus.Faulted &&
      c.availability === "Operative" &&
      c.status !== OCPPStatus.Charging &&
      !c.transaction,
  );
}

/**
 * The capacity rule of OCPP 1.6 §5.13, shared by ReserveNow and the start of a
 * session so both count the same way: the connectors that can still take a
 * session, other than `takenConnectorId` and those holding their own
 * reservation, less one per connector-0 reservation (`ignoreReservationId`,
 * the reservation a ReserveNow replaces, is left out). A negative result means
 * the connector-0 reservations no longer have a connector each.
 */
function connectorCapacityShortfall16(
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
 * Whether a session of `idTag` on `connectorId` must be refused because it
 * would leave an active connector-0 reservation of another tag without a
 * connector (OCPP 1.6 edition 2 §5.13: "at any time during the validity of the
 * reservation, one connector remains available for the reserved idTag"). A tag
 * that holds the reservation that applies to this connector (its own, or via
 * `parentIdTag`) is never refused. Uses the capacity rule of
 * {@link reserveNowRefusal16}.
 */
export function startBlockedByReservation16(
  cp: ChargePoint,
  connectorId: number,
  idTag: string,
): boolean {
  if (isOcpp2Version(cp.ocppVersion)) return false;
  if (cp.reservationManager.reservationFor(connectorId, idTag)) return false;
  return connectorCapacityShortfall16(cp, connectorId) < 0;
}

/**
 * Why an OCPP 1.6 ReserveNow cannot be accepted, or `null` when the station
 * can take it. Everything here depends on the station only (the reservation
 * manager's own checks, an expired date or a taken connector, come after), so
 * a caller can run it before it spends an Authorize.req on the idTag.
 *
 * Capacity (#595): the station keeps one connector available for each
 * reservation. With `free` the connectors that can still take a session,
 * `specific` those among them that hold their own reservation and `zero` the
 * connector-0 reservations (the one this ReserveNow replaces is left out of
 * both), a connector-0 ReserveNow needs `free − specific − zero ≥ 1`, and a
 * ReserveNow for connector `n` needs the connectors other than `n` to still
 * cover `zero`. Otherwise the answer is `Occupied`.
 */
export function reserveNowRefusal16(
  cp: ChargePoint,
  req: ReserveNow16Request,
): ReservationStatus | null {
  const { connectorId } = req;
  if (
    connectorId === 0 &&
    cp.configuration.getBoolean("ReserveConnectorZeroSupported") !== true
  ) {
    return ReservationStatus.Rejected;
  }
  if (connectorId !== 0) {
    const connector = cp.getConnector(connectorId);
    if (!connector) return ReservationStatus.Rejected;
    if (connector.status === OCPPStatus.Faulted) {
      return ReservationStatus.Faulted;
    }
    if (connector.status === OCPPStatus.Charging || connector.transaction) {
      return ReservationStatus.Occupied;
    }
    if (connector.availability !== "Operative") {
      return ReservationStatus.Unavailable;
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

  // Connector 0 itself needs one of the spare connectors; a specific
  // reservation takes its own connector and leaves the rest to `zero`.
  if (
    connectorCapacityShortfall16(cp, connectorId, req.reservationId) <
    (connectorId === 0 ? 1 : 0)
  ) {
    return ReservationStatus.Occupied;
  }
  return null;
}

/**
 * OCPP 1.6 ReserveNow with `connectorId` 0 (#595): a reservation that any
 * connector can honour, once {@link reserveNowRefusal16} found room for it.
 */
function acceptAnyConnector(
  cp: ChargePoint,
  req: ReserveNow16Request,
): { response: { status: ReservationStatus } } {
  const replaced = cp.reservationManager.getReservation(req.reservationId);
  const status = cp.reservationManager.createReservation(
    0,
    new Date(req.expiryDate),
    req.idTag,
    req.parentIdTag,
    req.reservationId,
    { replaceExisting: true, shareAnyConnector: true },
  );
  if (status === ReservationStatus.Accepted && replaced) {
    releaseIfUnreserved(cp, replaced.connectorId);
  }
  return { response: { status } };
}
