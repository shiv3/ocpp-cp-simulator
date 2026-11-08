import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import {
  CancelReservationStatus,
  OCPPStatus,
  ReservationStatus,
} from "../../../domain/types/OcppTypes";
import { isOcpp2Version } from "../../../domain/types/OcppVersion";
import {
  reserveNowRefusal,
  syncUnspecifiedReservations,
} from "../../../domain/reservation/reservationModel";

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
 * One model for both versions (domain/reservation/reservationModel.ts).
 * A ReserveNow whose id is already held replaces that reservation (1.6
 * ReserveNow.req; 2.x H01.FR.02, #710); when the old one sat on another
 * connector, that connector goes back to `Available`. A reservation that
 * names no connector (1.6 `connectorId` 0, 2.x no `evseId`) is accepted only
 * when `ReserveConnectorZeroSupported` / `ReservationCtrlr.NonEvseSpecific`
 * is true (else `Rejected`, H01.FR.19, #709). It belongs to its idTag /
 * parentIdTag: only that tag's session consumes it. The station keeps one
 * connector available for each reservation, so a ReserveNow is `Occupied`
 * when the free connectors, less those with their own reservation and less
 * one per reservation without a connector, cannot take it
 * ({@link reserveNowRefusal}), and for the whole validity of such a
 * reservation a session of another tag that would take the last such
 * connector is refused (`startRefusalByReservation`). 1.6 leaves the
 * connectors' status alone for it; 2.x shows Reserved on the free EVSEs once
 * the reservations equal them (H01.FR.20). A 2.x EVSE that is not Available
 * (a plugged cable counts) answers `Occupied` (H01.FR.11).
 *
 * A start on a connector reserved for another tag does not happen (1.6
 * §5.13, H03.FR.09): see transaction.ts.
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
          const reservationId = two ? req.id : req.reservationId;
          // 0 names no connector: 1.6 connector 0, 2.x ReserveNow without
          // `evseId` (a reservation on an unspecified EVSE, H01.FR.04).
          const connectorId = two ? (req.evseId ?? 0) : req.connectorId;
          const refusal = reserveNowRefusal(cp, connectorId, reservationId);
          if (refusal) return { response: { status: refusal } };

          const manager = cp.reservationManager;
          const replaced = manager.getReservation(reservationId);
          const status = two
            ? manager.createReservation(
                connectorId,
                new Date(req.expiryDateTime),
                req.idToken.idToken,
                req.groupIdToken?.idToken,
                reservationId,
                { replaceExisting: true, shareAnyConnector: true },
              )
            : manager.createReservation(
                connectorId,
                new Date(req.expiryDate),
                req.idTag,
                req.parentIdTag,
                reservationId,
                { replaceExisting: true, shareAnyConnector: true },
              );
          if (status !== ReservationStatus.Accepted) {
            return { response: { status } };
          }
          // A bare `connector.status = …` fires only the connector-local
          // event and the CSMS never sees the transition, hence
          // `updateConnectorStatus`.
          const settle = (): void => {
            if (replaced && replaced.connectorId !== connectorId) {
              releaseIfUnreserved(cp, replaced.connectorId);
            }
            const connector = cp.getConnector(connectorId);
            if (connector && connector.status !== OCPPStatus.Reserved) {
              cp.updateConnectorStatus(connectorId, OCPPStatus.Reserved);
            }
            syncUnspecifiedReservations(cp);
          };
          if (two) {
            return { response: { status }, after: async () => settle() };
          }
          settle();
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
            syncUnspecifiedReservations(cp);
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

/**
 * Why an OCPP 1.6 ReserveNow cannot be accepted, or `null` when the station
 * can take it ({@link reserveNowRefusal}; the station-only checks, so a caller
 * can run it before it spends an Authorize.req on the idTag).
 */
export function reserveNowRefusal16(
  cp: ChargePoint,
  req: ReserveNow16Request,
): ReservationStatus | null {
  return reserveNowRefusal(cp, req.connectorId, req.reservationId);
}
