import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReservationManager } from "../Reservation";
import { Logger } from "../../../shared/Logger";
import { ReservationStatus, OCPPStatus } from "../../types/OcppTypes";
import { ChargePoint } from "../../charge-point/ChargePoint";
import { DefaultBootNotification } from "../../types/OcppTypes";

/**
 * #186 follow-up: a reservation that lapses (expiry passes) without an
 * explicit CancelReservation must still return the connector to Available on
 * the wire. Previously the periodic cleanup deleted the reservation but left
 * the connector stuck Reserved.
 */
describe("ReservationManager expiry callback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires onExpire with the connector id when a reservation lapses", () => {
    const onExpire = vi.fn();
    const mgr = new ReservationManager(new Logger(), onExpire);
    expect(
      mgr.createReservation(
        1,
        new Date("2026-07-13T00:01:00Z"),
        "TAG",
        undefined,
        42,
      ),
    ).toBe(ReservationStatus.Accepted);

    // Before expiry: cleanup is a no-op.
    mgr.cleanupExpiredReservations();
    expect(onExpire).not.toHaveBeenCalled();

    // Past expiry: cleanup drops it AND notifies the owner.
    vi.setSystemTime(new Date("2026-07-13T00:02:00Z"));
    mgr.cleanupExpiredReservations();
    expect(onExpire).toHaveBeenCalledExactlyOnceWith(1);

    mgr.stopCleanupTimer();
  });

  it("isolates a throwing onExpire so the cleanup loop keeps going", () => {
    // The first connector's callback throws; the second must still be notified
    // and the exception must not escape the (timer-invoked) cleanup loop.
    const onExpire = vi.fn((connectorId: number) => {
      if (connectorId === 1) throw new Error("boom");
    });
    const mgr = new ReservationManager(new Logger(), onExpire);
    mgr.createReservation(
      1,
      new Date("2026-07-13T00:01:00Z"),
      "TAG",
      undefined,
      1,
    );
    mgr.createReservation(
      2,
      new Date("2026-07-13T00:01:00Z"),
      "TAG",
      undefined,
      2,
    );

    vi.setSystemTime(new Date("2026-07-13T00:02:00Z"));
    expect(() => mgr.cleanupExpiredReservations()).not.toThrow();
    expect(onExpire).toHaveBeenCalledWith(1);
    expect(onExpire).toHaveBeenCalledWith(2);
    // Both expired reservations were dropped regardless of the throw.
    expect(mgr.getAllReservations()).toHaveLength(0);

    mgr.stopCleanupTimer();
  });

  it("does NOT fire onExpire on an explicit cancellation", () => {
    const onExpire = vi.fn();
    const mgr = new ReservationManager(new Logger(), onExpire);
    mgr.createReservation(
      2,
      new Date("2026-07-13T00:05:00Z"),
      "TAG",
      undefined,
      7,
    );
    expect(mgr.cancelReservation(7)).toBe(true);
    // Cancelled reservation is gone, so a later cleanup finds nothing.
    vi.setSystemTime(new Date("2026-07-13T00:06:00Z"));
    mgr.cleanupExpiredReservations();
    expect(onExpire).not.toHaveBeenCalled();
    mgr.stopCleanupTimer();
  });
});

describe("ChargePoint: connector returns to Available on reservation expiry (#186)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function buildCp(): ChargePoint {
    return new ChargePoint(
      "test-cp-reservation-expiry",
      DefaultBootNotification,
      1,
      "ws://localhost:8080",
      null,
      null,
      null,
      {},
      [],
      "OCPP-1.6J",
      {},
    );
  }

  it("drives a Reserved connector back to Available when its reservation lapses", () => {
    const cp = buildCp();
    // Reserve connector 1, then reflect the Reserved status the handler sets.
    cp.reservationManager.createReservation(
      1,
      new Date("2026-07-13T00:01:00Z"),
      "TAG",
      undefined,
      99,
    );
    cp.updateConnectorStatus(1, OCPPStatus.Reserved);
    expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Reserved);

    // Expire it and run the cleanup the timer would.
    vi.setSystemTime(new Date("2026-07-13T00:02:00Z"));
    cp.reservationManager.cleanupExpiredReservations();

    expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Available);
  });

  it("does NOT clobber a connector that moved on (e.g. Charging) before expiry", () => {
    const cp = buildCp();
    cp.reservationManager.createReservation(
      1,
      new Date("2026-07-13T00:01:00Z"),
      "TAG",
      undefined,
      100,
    );
    // Connector progressed past Reserved (a transaction started on it).
    cp.updateConnectorStatus(1, OCPPStatus.Charging);

    vi.setSystemTime(new Date("2026-07-13T00:02:00Z"));
    cp.reservationManager.cleanupExpiredReservations();

    // Guard: not reset — a live Charging connector must not drop to Available.
    expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Charging);
  });
});
