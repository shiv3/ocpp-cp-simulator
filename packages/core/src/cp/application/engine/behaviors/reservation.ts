import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
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
          reserve();
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
