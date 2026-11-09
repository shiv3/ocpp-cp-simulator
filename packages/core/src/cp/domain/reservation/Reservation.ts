import { ReservationStatus } from "../types/OcppTypes";
import type { Logger } from "../../shared/Logger";
import { LogType } from "../../shared/Logger";
import { realClock } from "../../shared/clock";
import type { SimClock, TimerHandle } from "../../shared/clock";

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
  private cleanupTimer?: TimerHandle;
  /** Invoked with the connector id each time a reservation is dropped by
   *  cleanupExpiredReservations() because its expiry passed — from the periodic
   *  timer, or lazily via getReservationForConnector()/getAllReservations(). Lets
   *  the owner (ChargePoint) return the connector Reserved → Available and emit
   *  the StatusNotification; without it a lapsed reservation left the connector
   *  stuck Reserved on the wire. Explicit cancel/use paths delete directly and
   *  do NOT fire this — their status transition is handled by the caller. */
  private readonly onExpire?: (
    connectorId: number,
    reservation: Reservation,
  ) => void;

  private readonly clock: SimClock;
  /** One timer per reservation, armed at its `expiryDate` (#739). */
  private readonly expiryTimers = new Map<number, TimerHandle>();

  constructor(
    logger: Logger,
    onExpire?: (connectorId: number, reservation: Reservation) => void,
    clock: SimClock = realClock,
  ) {
    this.clock = clock;
    this.logger = logger;
    this.onExpire = onExpire;
    this.startCleanupTimer();
  }

  /**
   * Create a new reservation
   * @param connectorId Connector ID (0 = any connector)
   * @param expiryDate Expiry date/time
   * @param idTag ID tag for which the reservation is made
   * @param parentIdTag Optional parent ID tag
   * @param reservationId Reservation ID from central system
   * @param options `replaceExisting`: OCPP 1.6 ReserveNow replaces the
   *   reservation that has the same `reservationId` (#595); the other checks
   *   run as if it were already gone, and it is only dropped when the new one
   *   is accepted (2.x passes it too, OCPP 2.0.1 H01.FR.02). Without it a
   *   repeated id is `Rejected`.
   *   `shareAnyConnector`: connector-0 reservations do not exclude each other
   *   (1.6 only needs one connector kept free per reservation); the caller
   *   checks that enough connectors remain.
   * @returns ReservationStatus
   */
  createReservation(
    connectorId: number,
    expiryDate: Date,
    idTag: string,
    parentIdTag: string | undefined,
    reservationId: number,
    options: { replaceExisting?: boolean; shareAnyConnector?: boolean } = {},
  ): ReservationStatus {
    const replaced = options.replaceExisting
      ? this.reservations.get(reservationId)
      : undefined;
    if (replaced) this.drop(reservationId);
    const status = this.tryCreate(
      connectorId,
      expiryDate,
      idTag,
      parentIdTag,
      reservationId,
      options.shareAnyConnector === true,
    );
    if (replaced && status !== ReservationStatus.Accepted) {
      this.store(replaced);
    }
    return status;
  }

  private tryCreate(
    connectorId: number,
    expiryDate: Date,
    idTag: string,
    parentIdTag: string | undefined,
    reservationId: number,
    shareAnyConnector: boolean,
  ): ReservationStatus {
    // Check if reservation ID already exists
    if (this.reservations.has(reservationId)) {
      this.logger.warn(
        `Reservation ID ${reservationId} already exists`,
        LogType.GENERAL,
      );
      return ReservationStatus.Rejected;
    }

    // Check if connector already has a reservation: its own, exactly. A
    // connector-0 reservation is not "on" any connector, so it neither blocks
    // a specific reservation nor (with `shareAnyConnector`) another
    // connector-0 one; the caller counts the connectors that remain.
    const existingReservation =
      shareAnyConnector && connectorId === 0
        ? undefined
        : this.reservationOn(connectorId);
    if (existingReservation) {
      this.logger.warn(
        `Connector ${connectorId} already has an active reservation`,
        LogType.GENERAL,
      );
      return ReservationStatus.Occupied;
    }

    // Check if expiry date is in the past
    if (expiryDate.getTime() <= this.clock.now()) {
      this.logger.warn(
        `Reservation expiry date is in the past: ${expiryDate}`,
        LogType.GENERAL,
      );
      return ReservationStatus.Rejected;
    }

    const reservation: Reservation = {
      reservationId,
      connectorId,
      expiryDate,
      idTag,
      parentIdTag,
      createdAt: new Date(this.clock.now()),
    };

    this.store(reservation);

    this.logger.info(
      `Created reservation ${reservationId} for connector ${connectorId} (idTag: ${idTag}, expiry: ${expiryDate})`,
      LogType.GENERAL,
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
        LogType.GENERAL,
      );
      return false;
    }

    this.drop(reservationId);

    this.logger.info(
      `Cancelled reservation ${reservationId} (connector: ${reservation.connectorId})`,
      LogType.GENERAL,
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

    this.drop(reservationId);

    this.logger.info(
      `Used reservation ${reservationId} (connector: ${reservation.connectorId})`,
      LogType.GENERAL,
    );

    return true;
  }

  /**
   * The reservation made for exactly `connectorId` (connector 0 included), if
   * any. A connector-0 reservation is never returned for another connector.
   */
  reservationOn(connectorId: number): Reservation | undefined {
    this.cleanupExpiredReservations();
    for (const reservation of this.reservations.values()) {
      if (reservation.connectorId === connectorId) return reservation;
    }
    return undefined;
  }

  /** Whether {@link reservationOn} finds a reservation for `connectorId`. */
  hasReservationOn(connectorId: number): boolean {
    return this.reservationOn(connectorId) !== undefined;
  }

  /**
   * The reservation that applies to a session of `idTag` on `connectorId`
   * (OCPP 1.6 §5.13, §3.11; 2.0.1 H03.FR.01-06): the one made for exactly that
   * connector, else a connector-0 reservation, provided it admits the tag
   * ({@link reservationAdmits}; `parentOfTag` is the tag's parent id or
   * groupIdToken when the station knows it). A reservation held by someone
   * else is never returned, so another tag's session neither consumes nor
   * cancels it; whether such a session is *refused* is the caller's decision
   * ({@link reservationOn}).
   */
  reservationFor(
    connectorId: number,
    idTag: string,
    parentOfTag?: string,
  ): Reservation | undefined {
    const exact = this.reservationOn(connectorId);
    if (exact) {
      return reservationAdmits(exact, idTag, parentOfTag) ? exact : undefined;
    }
    if (connectorId === 0) return undefined;
    for (const reservation of this.reservations.values()) {
      if (
        reservation.connectorId === 0 &&
        reservationAdmits(reservation, idTag, parentOfTag)
      ) {
        return reservation;
      }
    }
    return undefined;
  }

  /**
   * Terminate every reservation `selector` names, without the expiry callback
   * (the caller reports the termination): the reservations on one connector,
   * or all of them. OCPP 1.6 §5.13 (a connector or the station becoming
   * Faulted or Unavailable ends the reservation), 2.0.1 H01.FR.16/17.
   * @returns the terminated reservations
   */
  terminateReservations(
    selector: { connectorId: number } | "all",
  ): Reservation[] {
    const terminated = [...this.reservations.values()].filter(
      (r) => selector === "all" || r.connectorId === selector.connectorId,
    );
    for (const reservation of terminated) {
      this.drop(reservation.reservationId);
      this.logger.info(
        `Terminated reservation ${reservation.reservationId} (connector: ${reservation.connectorId})`,
        LogType.GENERAL,
      );
    }
    return terminated;
  }

  /**
   * Get reservation for a specific connector, falling back to any connector-0
   * reservation whatever its tag. Only for observing ("is there a reservation
   * that could concern this connector?"); consuming or cancelling goes through
   * {@link reservationFor} / {@link reservationOn}.
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
    const now = new Date(this.clock.now());
    const expiredReservationIds: number[] = [];

    for (const [id, reservation] of this.reservations.entries()) {
      if (reservation.expiryDate <= now) {
        expiredReservationIds.push(id);
      }
    }

    for (const id of expiredReservationIds) {
      const reservation = this.reservations.get(id);
      this.drop(id);
      this.logger.info(
        `Cleaned up expired reservation ${id} (connector: ${reservation?.connectorId})`,
        LogType.GENERAL,
      );
      // Return the connector to Available on the wire — the reservation
      // lapsed without an explicit CancelReservation, so nothing else would.
      // Guard the callback: this runs from the setInterval timer, so an
      // uncaught throw here would escape the interval and could kill the
      // process / stop future cleanups. Isolate it and keep cleaning up.
      if (reservation) {
        try {
          this.onExpire?.(reservation.connectorId, reservation);
        } catch (err) {
          this.logger.error(
            `onExpire callback threw for connector ${reservation.connectorId}: ${String(err)}`,
            LogType.GENERAL,
          );
        }
      }
    }
  }

  private store(reservation: Reservation): void {
    this.reservations.set(reservation.reservationId, reservation);
    this.armExpiry(reservation);
  }

  private drop(reservationId: number): void {
    this.reservations.delete(reservationId);
    const timer = this.expiryTimers.get(reservationId);
    if (timer !== undefined) {
      this.clock.clearTimeout(timer);
      this.expiryTimers.delete(reservationId);
    }
  }

  /**
   * #739, OCPP 1.6 §5.13 / 2.0.1 H04.FR.01: the reservation is ended at its
   * `expiryDate`, not at the next 60 s sweep. A timer that fires a tick early
   * re-arms for what is left.
   */
  private armExpiry(reservation: Reservation): void {
    const { reservationId } = reservation;
    const previous = this.expiryTimers.get(reservationId);
    if (previous !== undefined) this.clock.clearTimeout(previous);
    const delay = Math.max(
      1,
      reservation.expiryDate.getTime() - this.clock.now(),
    );
    this.expiryTimers.set(
      reservationId,
      this.clock.setTimeout(() => {
        this.expiryTimers.delete(reservationId);
        this.cleanupExpiredReservations();
        if (this.reservations.get(reservationId) === reservation) {
          this.armExpiry(reservation);
        }
      }, delay),
    );
  }

  /**
   * Start the periodic sweep (every minute): only a fallback now that each
   * reservation has its own expiry timer.
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = this.clock.setInterval(() => {
      this.cleanupExpiredReservations();
    }, 60000); // Run every minute
  }

  /**
   * Stop automatic cleanup timer
   */
  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      this.clock.clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  /**
   * Put reservations back after a connection loss that was not a reboot
   * (#702): those whose expiry has not passed, with the cleanup timer
   * running again. Returns the ones restored.
   */
  restore(reservations: readonly Reservation[]): Reservation[] {
    const now = this.clock.now();
    const kept = reservations.filter((r) => r.expiryDate.getTime() > now);
    // `store` arms each one's expiry timer: `dispose()` cleared them when
    // the link was lost, and without it the 60 s sweep would end a
    // reservation up to a minute late (#839, H04.FR.01).
    for (const reservation of kept) {
      this.store({ ...reservation });
    }
    if (!this.cleanupTimer) this.startCleanupTimer();
    return kept;
  }

  /**
   * Cleanup all resources
   */
  dispose(): void {
    this.stopCleanupTimer();
    for (const timer of this.expiryTimers.values()) {
      this.clock.clearTimeout(timer);
    }
    this.expiryTimers.clear();
    this.reservations.clear();
  }
}

/**
 * Whether a session of `idTag` may use `reservation` (OCPP 1.6 §5.13: the
 * `idTag`, or a parent idTag equal to the reservation's `parentIdTag`; 2.0.1
 * H03.FR.01/04: the idToken, or the groupIdToken). `parentOfTag` is the
 * presented tag's parent id / groupIdToken as the station knows it (Local
 * Authorization List, Authorization Cache, Authorize.conf), if it does. The
 * presented tag being the reservation's parent tag itself counts too (#595).
 */
export function reservationAdmits(
  reservation: Reservation,
  idTag: string,
  parentOfTag?: string,
): boolean {
  if (reservation.idTag === idTag) return true;
  const { parentIdTag } = reservation;
  return (
    parentIdTag !== undefined &&
    (parentIdTag === idTag ||
      (parentOfTag !== undefined && parentOfTag === parentIdTag))
  );
}
