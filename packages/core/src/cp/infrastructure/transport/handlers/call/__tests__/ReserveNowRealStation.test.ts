import { describe, it, expect, vi } from "vitest";
import { ReserveNowHandler } from "../ReservationHandlers";
import type { HandlerContext } from "../../MessageHandlerRegistry";
import { ChargePoint } from "../../../../../domain/charge-point/ChargePoint";
import {
  DefaultBootNotification,
  OCPPStatus,
} from "../../../../../domain/types/OcppTypes";

/**
 * #595: ReserveNow on connector 0 (ReserveConnectorZeroSupported), replacement
 * by reservationId, and the opt-in idTag authorization, over a real station.
 */
function setup(options: { authorize?: boolean } = {}) {
  const chargePoint = new ChargePoint(
    "CP-RES-595",
    DefaultBootNotification,
    2,
    "ws://stub",
    null,
    null,
    null,
    {},
    [],
    "OCPP-1.6J",
    options.authorize ? { reservationAuthorizeIdTag: true } : {},
  );
  const ctx = { chargePoint, logger: chargePoint.logger } as HandlerContext;
  const handler = new ReserveNowHandler();
  const reserve = (
    connectorId: number,
    reservationId: number,
    idTag = "TAG-A",
  ) =>
    Promise.resolve(
      handler.handle(
        {
          connectorId,
          expiryDate: new Date(Date.now() + 3_600_000).toISOString(),
          idTag,
          reservationId,
        },
        ctx,
      ),
    );
  const status = (id: number) => chargePoint.getConnector(id)!.status;
  return { chargePoint, reserve, status };
}

describe("ReserveNow on connector 0 (#595)", () => {
  it("is Rejected while ReserveConnectorZeroSupported is false (the default)", async () => {
    const { chargePoint, reserve } = setup();
    expect(await reserve(0, 1)).toEqual({ status: "Rejected" });
    expect(chargePoint.reservationManager.getAllReservations()).toEqual([]);
  });

  it("is Accepted when ReserveConnectorZeroSupported is true, and no connector changes status", async () => {
    const { chargePoint, reserve, status } = setup();
    chargePoint.configuration.setRuntimeValue(
      "ReserveConnectorZeroSupported",
      true,
    );
    const before = [status(1), status(2)];
    expect(await reserve(0, 1)).toEqual({ status: "Accepted" });
    expect(chargePoint.reservationManager.getReservation(1)?.connectorId).toBe(
      0,
    );
    expect([status(1), status(2)]).toEqual(before);
  });

  it("is Occupied when every connector is in a transaction", async () => {
    const { chargePoint, reserve } = setup();
    chargePoint.configuration.setRuntimeValue(
      "ReserveConnectorZeroSupported",
      true,
    );
    for (const id of [1, 2]) {
      chargePoint.getConnector(id)!.beginTransaction({
        id: id + 100,
        connectorId: id,
        tagId: "T",
        meterStart: 0,
        meterStop: null,
        startTime: new Date(),
        stopTime: null,
        meterSent: false,
      });
    }
    expect(await reserve(0, 1)).toEqual({ status: "Occupied" });
  });
});

describe("ReserveNow replacement by reservationId (#595)", () => {
  it("replaces the reservation with the same id on the same connector", async () => {
    const { chargePoint, reserve, status } = setup();
    expect(await reserve(1, 7, "TAG-A")).toEqual({ status: "Accepted" });
    expect(await reserve(1, 7, "TAG-B")).toEqual({ status: "Accepted" });
    const all = chargePoint.reservationManager.getAllReservations();
    expect(all).toHaveLength(1);
    expect(all[0].idTag).toBe("TAG-B");
    expect(status(1)).toBe(OCPPStatus.Reserved);
  });

  it("moves a reservation to another connector and frees the first", async () => {
    const { chargePoint, reserve, status } = setup();
    await reserve(1, 7);
    expect(await reserve(2, 7)).toEqual({ status: "Accepted" });
    expect(chargePoint.reservationManager.getReservation(7)?.connectorId).toBe(
      2,
    );
    expect(status(1)).toBe(OCPPStatus.Available);
    expect(status(2)).toBe(OCPPStatus.Reserved);
  });

  it("keeps the old reservation when the replacement is refused", async () => {
    const { chargePoint, reserve } = setup();
    await reserve(1, 7, "TAG-A");
    await reserve(2, 8, "TAG-C");
    // Moving 7 onto connector 2 collides with reservation 8.
    expect(await reserve(2, 7, "TAG-B")).toEqual({ status: "Occupied" });
    expect(chargePoint.reservationManager.getReservation(7)?.idTag).toBe(
      "TAG-A",
    );
    expect(chargePoint.reservationManager.getReservation(7)?.connectorId).toBe(
      1,
    );
  });

  it("still answers Occupied for a different id on a reserved connector", async () => {
    const { reserve } = setup();
    await reserve(1, 7);
    expect(await reserve(1, 8)).toEqual({ status: "Occupied" });
  });
});

describe("ReserveNow reservationAuthorizeIdTag (#595)", () => {
  it("is off by default: no authorization happens", async () => {
    const { chargePoint, reserve } = setup();
    const authorize = vi.spyOn(chargePoint, "authorizeAndWait");
    expect(chargePoint.reservationAuthorizeIdTag).toBe(false);
    expect(await reserve(1, 1)).toEqual({ status: "Accepted" });
    expect(authorize).not.toHaveBeenCalled();
  });

  it("accepts when the idTag is authorized", async () => {
    const { chargePoint, reserve } = setup({ authorize: true });
    const authorize = vi
      .spyOn(chargePoint, "authorizeAndWait")
      .mockResolvedValue("Accepted");
    expect(await reserve(1, 1, "GOOD")).toEqual({ status: "Accepted" });
    expect(authorize).toHaveBeenCalledWith("GOOD");
  });

  it("rejects, reserving nothing, when the idTag is not authorized", async () => {
    const { chargePoint, reserve, status } = setup({ authorize: true });
    vi.spyOn(chargePoint, "authorizeAndWait").mockResolvedValue("Invalid");
    const before = status(1);
    expect(await reserve(1, 1, "BAD")).toEqual({ status: "Rejected" });
    expect(chargePoint.reservationManager.getAllReservations()).toEqual([]);
    expect(status(1)).toBe(before);
  });
});
