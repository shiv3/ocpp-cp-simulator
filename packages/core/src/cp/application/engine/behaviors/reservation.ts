import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import {
  CancelReservationStatus,
  OCPPStatus,
  ReservationStatus,
} from "../../../domain/types/OcppTypes";
import { isOcpp2Version } from "../../../domain/types/OcppVersion";

interface ReserveNow16Request {
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
 * is true (else `Rejected`), is `Faulted` / `Occupied` / `Unavailable` only
 * when no connector at all can take it, and leaves every connector's status
 * alone.
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
          if (!two && connectorId === 0) {
            return reserveAnyConnector(cp, req);
          }
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
                { replaceExisting: true },
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
    !cp.reservationManager.isConnectorReserved(connectorId)
  ) {
    cp.updateConnectorStatus(connectorId, OCPPStatus.Available);
  }
}

/**
 * OCPP 1.6 ReserveNow with `connectorId` 0 (#595): a reservation that any
 * connector can honour. `ReserveConnectorZeroSupported` (default false)
 * decides whether the station takes it at all.
 */
function reserveAnyConnector(
  cp: ChargePoint,
  req: ReserveNow16Request,
): { response: { status: ReservationStatus } } {
  if (cp.configuration.getBoolean("ReserveConnectorZeroSupported") !== true) {
    return { response: { status: ReservationStatus.Rejected } };
  }
  const connectors = [...cp.connectors.values()].filter((c) => c.id !== 0);
  if (
    connectors.length > 0 &&
    connectors.every((c) => c.status === OCPPStatus.Faulted)
  ) {
    return { response: { status: ReservationStatus.Faulted } };
  }
  const usable = connectors.filter((c) => c.status !== OCPPStatus.Faulted);
  if (
    usable.length > 0 &&
    usable.every((c) => c.availability !== "Operative")
  ) {
    return { response: { status: ReservationStatus.Unavailable } };
  }
  const free = usable.filter(
    (c) =>
      c.availability === "Operative" &&
      c.status !== OCPPStatus.Charging &&
      !c.transaction,
  );
  if (connectors.length > 0 && free.length === 0) {
    return { response: { status: ReservationStatus.Occupied } };
  }
  const replaced = cp.reservationManager.getReservation(req.reservationId);
  const status = cp.reservationManager.createReservation(
    0,
    new Date(req.expiryDate),
    req.idTag,
    req.parentIdTag,
    req.reservationId,
    { replaceExisting: true },
  );
  if (status === ReservationStatus.Accepted && replaced) {
    releaseIfUnreserved(cp, replaced.connectorId);
  }
  return { response: { status } };
}
