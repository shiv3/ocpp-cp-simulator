import { describe, it, expect, vi } from "vitest";
import {
  ReserveNowHandler,
  CancelReservationHandler,
} from "../ReservationHandlers";
import type { HandlerContext } from "../../MessageHandlerRegistry";
import type { ChargePoint } from "../../../../../domain/charge-point/ChargePoint";
import {
  ReservationStatus,
  CancelReservationStatus,
  OCPPStatus,
} from "../../../../../domain/types/OcppTypes";

/**
 * Issue #186: ReserveNow/CancelReservation must drive the connector through
 * `updateConnectorStatus` so an OCPP StatusNotification.req actually goes on
 * the wire for the Reserved / post-cancel Available transitions. The previous
 * `connector.status = …` assignment fired only the connector-local statusChange
 * event (enough for scenario statusTriggers) but the CSMS never saw the change.
 *
 * These tests pin that routing: a bare property write would leave the
 * `updateConnectorStatus` spy uncalled and fail the assertions below.
 */

interface ConnectorShape {
  status: OCPPStatus;
  availability: "Operative" | "Inoperative";
  transaction: unknown | null;
}

interface ReservationManagerShape {
  createReservation: ReturnType<typeof vi.fn>;
  getReservation: ReturnType<typeof vi.fn>;
  cancelReservation: ReturnType<typeof vi.fn>;
}

function buildContext(opts: {
  connector: ConnectorShape | null;
  reservationManager: Partial<ReservationManagerShape>;
}) {
  const updateConnectorStatus = vi.fn();
  const reservationManager: ReservationManagerShape = {
    createReservation: vi.fn(),
    getReservation: vi.fn(),
    cancelReservation: vi.fn(),
    ...opts.reservationManager,
  };
  const chargePoint = {
    getConnector: vi.fn(() => opts.connector),
    reservationManager,
    updateConnectorStatus,
  };
  const ctx = {
    chargePoint: chargePoint as unknown as ChargePoint,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as HandlerContext;
  return { ctx, updateConnectorStatus, reservationManager };
}

const reserveNowPayload = {
  connectorId: 1,
  expiryDate: new Date(Date.now() + 60_000).toISOString(),
  idTag: "CERT-TAG-1",
  parentIdTag: undefined,
  reservationId: 42,
};

describe("ReserveNowHandler (#186 StatusNotification wiring)", () => {
  it("drives the connector to Reserved via updateConnectorStatus on Accepted", () => {
    const { ctx, updateConnectorStatus } = buildContext({
      connector: {
        status: OCPPStatus.Available,
        availability: "Operative",
        transaction: null,
      },
      reservationManager: {
        createReservation: vi.fn(() => ReservationStatus.Accepted),
      },
    });

    const res = new ReserveNowHandler().handle(reserveNowPayload, ctx);

    expect(res).toEqual({ status: ReservationStatus.Accepted });
    // The whole point of #186: routed through updateConnectorStatus (which
    // emits StatusNotification), not a bare `connector.status =` assignment.
    expect(updateConnectorStatus).toHaveBeenCalledWith(1, OCPPStatus.Reserved);
  });

  it("does NOT touch connector status when the reservation is rejected", () => {
    const { ctx, updateConnectorStatus } = buildContext({
      connector: {
        status: OCPPStatus.Available,
        availability: "Operative",
        transaction: null,
      },
      reservationManager: {
        createReservation: vi.fn(() => ReservationStatus.Rejected),
      },
    });

    const res = new ReserveNowHandler().handle(reserveNowPayload, ctx);

    expect(res).toEqual({ status: ReservationStatus.Rejected });
    expect(updateConnectorStatus).not.toHaveBeenCalled();
  });

  it("rejects a Faulted connector as Faulted without a status update", () => {
    const { ctx, updateConnectorStatus } = buildContext({
      connector: {
        status: OCPPStatus.Faulted,
        availability: "Operative",
        transaction: null,
      },
      reservationManager: {},
    });

    const res = new ReserveNowHandler().handle(reserveNowPayload, ctx);

    expect(res).toEqual({ status: ReservationStatus.Faulted });
    expect(updateConnectorStatus).not.toHaveBeenCalled();
  });
});

describe("CancelReservationHandler (#186 StatusNotification wiring)", () => {
  it("restores the connector to Available via updateConnectorStatus", () => {
    const { ctx, updateConnectorStatus } = buildContext({
      connector: {
        status: OCPPStatus.Reserved,
        availability: "Operative",
        transaction: null,
      },
      reservationManager: {
        getReservation: vi.fn(() => ({ connectorId: 1, reservationId: 42 })),
        cancelReservation: vi.fn(() => true),
      },
    });

    const res = new CancelReservationHandler().handle(
      { reservationId: 42 },
      ctx,
    );

    expect(res).toEqual({ status: CancelReservationStatus.Accepted });
    expect(updateConnectorStatus).toHaveBeenCalledWith(1, OCPPStatus.Available);
  });

  it("does NOT emit an Available transition when the connector is not Reserved", () => {
    const { ctx, updateConnectorStatus } = buildContext({
      connector: {
        status: OCPPStatus.Charging,
        availability: "Operative",
        transaction: {},
      },
      reservationManager: {
        getReservation: vi.fn(() => ({ connectorId: 1, reservationId: 42 })),
        cancelReservation: vi.fn(() => true),
      },
    });

    const res = new CancelReservationHandler().handle(
      { reservationId: 42 },
      ctx,
    );

    // Still Accepted (the reservation was cancelled) but no wire transition —
    // an in-progress transaction must not be clobbered back to Available.
    expect(res).toEqual({ status: CancelReservationStatus.Accepted });
    expect(updateConnectorStatus).not.toHaveBeenCalled();
  });

  it("returns Rejected and emits nothing when the reservation does not exist", () => {
    const { ctx, updateConnectorStatus } = buildContext({
      connector: {
        status: OCPPStatus.Reserved,
        availability: "Operative",
        transaction: null,
      },
      reservationManager: {
        getReservation: vi.fn(() => undefined),
        cancelReservation: vi.fn(() => false),
      },
    });

    const res = new CancelReservationHandler().handle(
      { reservationId: 99999 },
      ctx,
    );

    expect(res).toEqual({ status: CancelReservationStatus.Rejected });
    expect(updateConnectorStatus).not.toHaveBeenCalled();
  });
});
