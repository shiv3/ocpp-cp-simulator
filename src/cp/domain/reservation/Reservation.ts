import { ReservationStatus } from "../types/OcppTypes";
import { Logger, LogType } from "../../shared/Logger";

/**
 * Reservation data structure
 * Represents an active reservation on a connector
 */
export interface Reservation {
  reservationId: number;
  connectorId: number;
  expiryDate: Date;
  idTag: string;
  parentIdTag?: string;
  createdAt: Date;
}

/**
 * ReservationManager
 * Manages reservations for all connectors in a charge point
 */
export class ReservationManager {
  private reservations: Map<number, Reservation> = new Map();
  private logger: Logger;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(logger: Logger) {
    this.logger = logger;
    this.startCleanupTimer();
  }

  /**
   * Create a new reservation
   * @param connectorId Connector ID (0 = any connector)
   * @param expiryDate Expiry date/time
   * @param idTag ID tag for which the reservation is made
   * @param parentIdTag Optional parent ID tag
   * @param reservationId Reservation ID from central system
   * @returns ReservationStatus
   */
  createReservation(
    connectorId: number,
    expiryDate: Date,
    idTag: string,
    parentIdTag: string | undefined,
    reservationId: number
  ): ReservationStatus {
    // Check if reservation ID already exists
    if (this.reservations.has(reservationId)) {
      this.logger.warn(
        `Reservation ID ${reservationId} already exists`,
        LogType.GENERAL
      );
      return ReservationStatus.Rejected;
    }

    // Check if connector already has a reservation
    const existingReservation = this.getReservationForConnector(connectorId);
    if (existingReservation) {
      this.logger.warn(
        `Connector ${connectorId} already has an active reservation`,
        LogType.GENERAL
      );
      return ReservationStatus.Occupied;
    }

    // Check if expiry date is in the past
    if (expiryDate <= new Date()) {
      this.logger.warn(
        `Reservation expiry date is in the past: ${expiryDate}`,
        LogType.GENERAL
      );
      return ReservationStatus.Rejected;
    }

    const reservation: Reservation = {
      reservationId,
      connectorId,
      expiryDate,
      idTag,
      parentIdTag,
      createdAt: new Date(),
    };

    this.reservations.set(reservationId, reservation);

    this.logger.info(
      `Created reservation ${reservationId} for connector ${connectorId} (idTag: ${idTag}, expiry: ${expiryDate})`,
      LogType.GENERAL
    );

    return ReservationStatus.Accepted;
  }

  /**
   * Cancel an existing reservation
   * @param reservationId Reservation ID to cancel
   * @returns true if cancelled successfully, false if not found
   */
  cancelReservation(reservationId: number): boolean {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      this.logger.warn(
        `Reservation ${reservationId} not found`,
        LogType.GENERAL
      );
      return false;
    }

    this.reservations.delete(reservationId);

    this.logger.info(
      `Cancelled reservation ${reservationId} (connector: ${reservation.connectorId})`,
      LogType.GENERAL
    );

    return true;
  }

  /**
   * Use a reservation (mark as used and remove it)
   * Called when a transaction starts
   * @param reservationId Reservation ID to use
   * @returns true if used successfully, false if not found
   */
  useReservation(reservationId: number): boolean {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      return false;
    }

    this.reservations.delete(reservationId);

    this.logger.info(
      `Used reservation ${reservationId} (connector: ${reservation.connectorId})`,
      LogType.GENERAL
    );

    return true;
  }

  /**
   * Check if a reservation is valid for a given ID tag
   * @param reservationId Reservation ID
   * @param idTag ID tag attempting to use the reservation
   * @returns true if valid, false otherwise
   */
  isValidReservation(reservationId: number, idTag: string): boolean {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      return false;
    }

    // Check if expired
    if (reservation.expiryDate <= new Date()) {
      this.logger.warn(
        `Reservation ${reservationId} has expired`,
        LogType.GENERAL
      );
      return false;
    }

    // Check if ID tag matches (or parent ID tag matches)
    if (
      reservation.idTag === idTag ||
      reservation.parentIdTag === idTag
    ) {
      return true;
    }

    return false;
  }

  /**
   * Get reservation for a specific connector
   * @param connectorId Connector ID
   * @returns Reservation if found, undefined otherwise
   */
  getReservationForConnector(connectorId: number): Reservation | undefined {
    // First, clean up expired reservations
    this.cleanupExpiredReservations();

    // Check for exact connector match
    for (const reservation of this.reservations.values()) {
      if (reservation.connectorId === connectorId) {
        return reservation;
      }
    }

    // If connectorId is not 0, also check for reservations on connector 0 (any connector)
    if (connectorId !== 0) {
      for (const reservation of this.reservations.values()) {
        if (reservation.connectorId === 0) {
          return reservation;
        }
      }
    }

    return undefined;
  }

  /**
   * Get reservation by ID
   * @param reservationId Reservation ID
   * @returns Reservation if found, undefined otherwise
   */
  getReservation(reservationId: number): Reservation | undefined {
    return this.reservations.get(reservationId);
  }

  /**
   * Get all active reservations
   * @returns Array of all reservations
   */
  getAllReservations(): Reservation[] {
    this.cleanupExpiredReservations();
    return Array.from(this.reservations.values());
  }

  /**
   * Check if a connector is reserved
   * @param connectorId Connector ID
   * @returns true if reserved, false otherwise
   */
  isConnectorReserved(connectorId: number): boolean {
    return this.getReservationForConnector(connectorId) !== undefined;
  }

  /**
   * Clean up expired reservations
   */
  cleanupExpiredReservations(): void {
    const now = new Date();
    const expiredReservationIds: number[] = [];

    for (const [id, reservation] of this.reservations.entries()) {
      if (reservation.expiryDate <= now) {
        expiredReservationIds.push(id);
      }
    }

    for (const id of expiredReservationIds) {
      const reservation = this.reservations.get(id);
      this.reservations.delete(id);
      this.logger.info(
        `Cleaned up expired reservation ${id} (connector: ${reservation?.connectorId})`,
        LogType.GENERAL
      );
    }
  }

  /**
   * Start automatic cleanup timer (runs every minute)
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredReservations();
    }, 60000); // Run every minute
  }

  /**
   * Stop automatic cleanup timer
   */
  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /**
   * Cleanup all resources
   */
  dispose(): void {
    this.stopCleanupTimer();
    this.reservations.clear();
  }
}
