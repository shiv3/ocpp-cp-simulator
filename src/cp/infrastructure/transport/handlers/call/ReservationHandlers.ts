import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import type {} from "../../../../../ocpp";
import {
  ReservationStatus,
  CancelReservationStatus,
  OCPPStatus,
} from "../../../../domain/types/OcppTypes";

/**
 * Handler for ReserveNow request
 *
 * This handler processes reservation requests from the central system.
 * The reservation allows a specific ID tag to use a connector at a future time.
 */
export class ReserveNowHandler implements CallHandler<
  ReserveNowRequestV16,
  ReserveNowResponseV16
> {
  handle(
    payload: ReserveNowRequestV16,
    context: HandlerContext,
  ): ReserveNowResponseV16 {
    const { connectorId, expiryDate, idTag, parentIdTag, reservationId } =
      payload;
    const connector = context.chargePoint.getConnector(connectorId);
    const reservationManager = context.chargePoint.reservationManager;

    // Check if connector exists
    if (!connector) {
      return { status: ReservationStatus.Rejected };
    }

    // Check if connector is available
    if (connector.status === OCPPStatus.Faulted) {
      return { status: ReservationStatus.Faulted };
    }

    // Check if connector is already in use (charging)
    if (connector.status === OCPPStatus.Charging || connector.transaction) {
      return { status: ReservationStatus.Occupied };
    }

    // Check if connector is unavailable (not operative)
    if (connector.availability !== "Operative") {
      return { status: ReservationStatus.Unavailable };
    }

    // Parse expiry date
    const expiryDateTime = new Date(expiryDate);

    // Create the reservation
    const status = reservationManager.createReservation(
      connectorId,
      expiryDateTime,
      idTag,
      parentIdTag,
      reservationId,
    );

    // If reservation was accepted, drive the connector to Reserved through
    // updateConnectorStatus so an OCPP StatusNotification(Reserved) is emitted
    // on the wire (a bare `connector.status = …` fires only the connector-local
    // statusChange event and the CSMS never sees the transition).
    if (status === ReservationStatus.Accepted) {
      context.chargePoint.updateConnectorStatus(
        connectorId,
        OCPPStatus.Reserved,
      );
    }

    return { status };
  }
}

/**
 * Handler for CancelReservation request
 *
 * This handler processes cancellation requests for existing reservations.
 */
export class CancelReservationHandler implements CallHandler<
  CancelReservationRequestV16,
  CancelReservationResponseV16
> {
  handle(
    payload: CancelReservationRequestV16,
    context: HandlerContext,
  ): CancelReservationResponseV16 {
    const { reservationId } = payload;
    const reservationManager = context.chargePoint.reservationManager;

    // Get the reservation before cancelling to update connector status
    const reservation = reservationManager.getReservation(reservationId);

    // Cancel the reservation
    const cancelled = reservationManager.cancelReservation(reservationId);

    if (cancelled && reservation) {
      // Update connector status back to Available
      const connector = context.chargePoint.getConnector(
        reservation.connectorId,
      );
      if (connector && connector.status === OCPPStatus.Reserved) {
        // Route through updateConnectorStatus so StatusNotification(Available)
        // is sent for the post-cancel transition (mirrors ReserveNow above).
        context.chargePoint.updateConnectorStatus(
          reservation.connectorId,
          OCPPStatus.Available,
        );
      }

      return { status: CancelReservationStatus.Accepted };
    }

    return { status: CancelReservationStatus.Rejected };
  }
}
