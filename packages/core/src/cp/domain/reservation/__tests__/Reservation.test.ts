import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReservationManager, reservationAdmits } from "../Reservation";
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
    expect(onExpire).toHaveBeenCalledExactlyOnceWith(
      1,
      expect.objectContaining({ reservationId: 42 }),
    );

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
    expect(onExpire).toHaveBeenCalledWith(1, expect.anything());
    expect(onExpire).toHaveBeenCalledWith(2, expect.anything());
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

/**
 * #739, OCPP 1.6 §5.13 / 2.0.1 H04.FR.01: the reservation ends at its
 * `expiryDate`, not at the next 60 s sweep.
 */
describe("ReservationManager expiry timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const reserve = (
    mgr: ReservationManager,
    id: number,
    expiry: string,
    connectorId = 1,
  ) =>
    mgr.createReservation(connectorId, new Date(expiry), "TAG", undefined, id);

  it("fires at the expiry time, long before the 60 s sweep", () => {
    const onExpire = vi.fn();
    const mgr = new ReservationManager(new Logger(), onExpire);
    reserve(mgr, 1, "2026-07-13T00:00:07Z");

    vi.advanceTimersByTime(6_999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledExactlyOnceWith(
      1,
      expect.objectContaining({ reservationId: 1 }),
    );
    expect(mgr.getReservation(1)).toBeUndefined();
    mgr.dispose();
  });

  it("sends nothing at T when the reservation was cancelled or used before", () => {
    const onExpire = vi.fn();
    const mgr = new ReservationManager(new Logger(), onExpire);
    reserve(mgr, 1, "2026-07-13T00:00:07Z");
    reserve(mgr, 2, "2026-07-13T00:00:07Z", 2);
    mgr.cancelReservation(1);
    mgr.useReservation(2);

    vi.advanceTimersByTime(10_000);
    expect(onExpire).not.toHaveBeenCalled();
    mgr.dispose();
  });

  it("re-arms the timer when a reservation is replaced, and keeps the old one when the replacement is refused", () => {
    const onExpire = vi.fn();
    const mgr = new ReservationManager(new Logger(), onExpire);
    reserve(mgr, 1, "2026-07-13T00:00:05Z");
    mgr.createReservation(
      1,
      new Date("2026-07-13T00:00:20Z"),
      "TAG",
      undefined,
      1,
      { replaceExisting: true },
    );
    vi.advanceTimersByTime(10_000);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(onExpire).toHaveBeenCalledTimes(1);

    // A replacement whose expiry is already past is refused; the old one lives.
    reserve(mgr, 3, "2026-07-13T00:01:00Z");
    expect(
      mgr.createReservation(
        1,
        new Date("2020-01-01T00:00:00Z"),
        "TAG",
        undefined,
        3,
        { replaceExisting: true },
      ),
    ).toBe(ReservationStatus.Rejected);
    vi.advanceTimersByTime(40_000);
    expect(onExpire).toHaveBeenCalledTimes(2);
    mgr.dispose();
  });

  it("holds a reservation further out than a platform timer reaches", () => {
    const onExpire = vi.fn();
    const mgr = new ReservationManager(new Logger(), onExpire);
    reserve(mgr, 1, "2026-09-13T00:00:00Z"); // 62 days, over 2^31 ms
    vi.advanceTimersByTime(30 * 24 * 3600_000);
    expect(onExpire).not.toHaveBeenCalled();
    expect(mgr.getReservation(1)).toBeDefined();
    mgr.dispose();
  });

  it("dispose clears the timers", () => {
    const onExpire = vi.fn();
    const mgr = new ReservationManager(new Logger(), onExpire);
    reserve(mgr, 1, "2026-07-13T00:00:07Z");
    mgr.dispose();
    vi.advanceTimersByTime(10_000);
    expect(onExpire).not.toHaveBeenCalled();
  });
});

describe("ReservationManager.terminateReservations (#731, #712)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends the reservations of one connector, or all, without the expiry callback", () => {
    const onExpire = vi.fn();
    const mgr = new ReservationManager(new Logger(), onExpire);
    const future = new Date(Date.now() + 3600_000);
    mgr.createReservation(1, future, "A", undefined, 1);
    mgr.createReservation(2, future, "B", undefined, 2);
    mgr.createReservation(0, future, "C", undefined, 3, {
      shareAnyConnector: true,
    });

    expect(
      mgr.terminateReservations({ connectorId: 1 }).map((r) => r.reservationId),
    ).toEqual([1]);
    expect(mgr.getReservation(1)).toBeUndefined();
    expect(mgr.getReservation(2)).toBeDefined();
    expect(
      mgr.terminateReservations("all").map((r) => r.reservationId),
    ).toEqual([2, 3]);
    expect(mgr.getAllReservations()).toEqual([]);
    expect(onExpire).not.toHaveBeenCalled();
    mgr.dispose();
  });
});

describe("reservationAdmits (#721, #711)", () => {
  const reservation = {
    reservationId: 1,
    connectorId: 1,
    expiryDate: new Date(),
    createdAt: new Date(),
    idTag: "OWNER",
    parentIdTag: "GROUP",
  };

  it("admits the idTag, its parent tag and a tag whose parent is the reservation's", () => {
    expect(reservationAdmits(reservation, "OWNER")).toBe(true);
    expect(reservationAdmits(reservation, "GROUP")).toBe(true);
    expect(reservationAdmits(reservation, "MEMBER", "GROUP")).toBe(true);
  });

  it("refuses a stranger, and a tag of another group", () => {
    expect(reservationAdmits(reservation, "OTHER")).toBe(false);
    expect(reservationAdmits(reservation, "OTHER", "OTHERGROUP")).toBe(false);
  });

  it("matches no parent when the reservation has none", () => {
    const plain = { ...reservation, parentIdTag: undefined };
    expect(reservationAdmits(plain, "MEMBER", "GROUP")).toBe(false);
    expect(reservationAdmits(plain, "OWNER")).toBe(true);
  });
});
