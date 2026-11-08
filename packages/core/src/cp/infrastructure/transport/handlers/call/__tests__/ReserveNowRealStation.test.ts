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
function setup(options: { authorize?: boolean; connectors?: number } = {}) {
  const chargePoint = new ChargePoint(
    "CP-RES-595",
    DefaultBootNotification,
    options.connectors ?? 2,
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
  const enableZero = () =>
    chargePoint.configuration.setRuntimeValue(
      "ReserveConnectorZeroSupported",
      true,
    );
  return { chargePoint, reserve, status, enableZero };
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

describe("moving a reservation to connector 0 (#595 review)", () => {
  it("frees the connector the reservation left, even though a connector-0 reservation now exists", async () => {
    const { chargePoint, reserve, status, enableZero } = setup();
    enableZero();
    const seen: string[] = [];
    chargePoint
      .getConnector(1)!
      .events.on("statusChange", ({ status }) => seen.push(status));
    await reserve(1, 7);
    expect(status(1)).toBe(OCPPStatus.Reserved);
    expect(await reserve(0, 7)).toEqual({ status: "Accepted" });
    expect(chargePoint.reservationManager.getReservation(7)?.connectorId).toBe(
      0,
    );
    expect(status(1)).toBe(OCPPStatus.Available);
    expect(seen).toEqual([OCPPStatus.Reserved, OCPPStatus.Available]);
  });

  it("frees a connector moved 1 -> 2 while another connector-0 reservation exists", async () => {
    const { reserve, status, enableZero } = setup({ connectors: 3 });
    enableZero();
    await reserve(0, 1, "ZERO");
    await reserve(1, 7);
    expect(await reserve(2, 7)).toEqual({ status: "Accepted" });
    expect(status(1)).toBe(OCPPStatus.Available);
    expect(status(2)).toBe(OCPPStatus.Reserved);
  });
});

// A remote start skips the Authorize gate a local start waits on.
const remote = { triggerReason: "RemoteStart" } as const;

describe("a connector-0 reservation belongs to its idTag (#595 review)", () => {
  it("is not consumed by a stranger starting on another connector, but by its owner", async () => {
    const { chargePoint, reserve, enableZero } = setup();
    enableZero();
    await reserve(0, 30, "OWNER");
    await chargePoint.startTransaction(
      "STRANGER",
      2,
      undefined,
      undefined,
      remote,
    );
    expect(chargePoint.getConnector(2)!.transaction?.reservationId).toBe(
      undefined,
    );
    expect(chargePoint.reservationManager.getReservation(30)).toBeDefined();
    await chargePoint.startTransaction(
      "OWNER",
      1,
      undefined,
      undefined,
      remote,
    );
    expect(chargePoint.getConnector(1)!.transaction?.reservationId).toBe(30);
    expect(chargePoint.reservationManager.getReservation(30)).toBeUndefined();
  });

  it("is consumed by its parentIdTag too", async () => {
    const { chargePoint, enableZero } = setup();
    enableZero();
    chargePoint.reservationManager.createReservation(
      0,
      new Date(Date.now() + 3_600_000),
      "OWNER",
      "FLEET",
      31,
    );
    await chargePoint.startTransaction(
      "FLEET",
      1,
      undefined,
      undefined,
      remote,
    );
    expect(chargePoint.getConnector(1)!.transaction?.reservationId).toBe(31);
  });

  it("manager: reservationFor never returns another tag's connector-0 reservation, reservationOn is exact", () => {
    const { chargePoint } = setup();
    const m = chargePoint.reservationManager;
    m.createReservation(
      0,
      new Date(Date.now() + 3_600_000),
      "OWNER",
      undefined,
      40,
    );
    expect(m.reservationFor(1, "STRANGER")).toBeUndefined();
    expect(m.reservationFor(1, "OWNER")?.reservationId).toBe(40);
    expect(m.reservationOn(1)).toBeUndefined();
    expect(m.hasReservationOn(0)).toBe(true);
  });
});

describe("ReserveNow capacity keeps a connector for each reservation (#595 review)", () => {
  it("accepts several connector-0 reservations while connectors remain, then Occupied", async () => {
    const { reserve, enableZero } = setup();
    enableZero();
    expect(await reserve(0, 1, "A")).toEqual({ status: "Accepted" });
    expect(await reserve(0, 2, "B")).toEqual({ status: "Accepted" });
    expect(await reserve(0, 3, "C")).toEqual({ status: "Occupied" });
  });

  it("a connector-0 reservation does not block a specific one that still leaves room", async () => {
    const { reserve, status, enableZero } = setup();
    enableZero();
    expect(await reserve(0, 1, "A")).toEqual({ status: "Accepted" });
    expect(await reserve(1, 2, "B")).toEqual({ status: "Accepted" });
    expect(status(1)).toBe(OCPPStatus.Reserved);
  });

  it("is Occupied for a specific reservation that would leave no connector for a connector-0 one", async () => {
    const { reserve, status, enableZero } = setup({ connectors: 1 });
    enableZero();
    expect(await reserve(0, 1, "A")).toEqual({ status: "Accepted" });
    const before = status(1);
    expect(await reserve(1, 2, "B")).toEqual({ status: "Occupied" });
    expect(status(1)).toBe(before);
  });

  it("is Occupied for connector 0 when every connector holds its own reservation", async () => {
    const { reserve, enableZero } = setup();
    enableZero();
    await reserve(1, 1, "A");
    await reserve(2, 2, "B");
    expect(await reserve(0, 3, "C")).toEqual({ status: "Occupied" });
  });

  it("replacing a connector-0 reservation does not count it against itself", async () => {
    const { reserve, enableZero } = setup({ connectors: 1 });
    enableZero();
    expect(await reserve(0, 1, "A")).toEqual({ status: "Accepted" });
    expect(await reserve(0, 1, "B")).toEqual({ status: "Accepted" });
  });
});

describe("ReserveNow checks the station before it authorizes (#595 review)", () => {
  it.each([
    ["an unknown connector", 9, "Rejected"],
    ["connector 0 while unsupported", 0, "Rejected"],
  ])("sends no Authorize.req for %s", async (_name, connectorId, expected) => {
    const { chargePoint, reserve } = setup({ authorize: true });
    const authorize = vi
      .spyOn(chargePoint, "authorizeAndWait")
      .mockResolvedValue("Accepted");
    expect(await reserve(connectorId, 1)).toEqual({ status: expected });
    expect(authorize).not.toHaveBeenCalled();
  });

  it("sends no Authorize.req for an Occupied connector either", async () => {
    const { chargePoint, reserve } = setup({ authorize: true });
    chargePoint.getConnector(1)!.beginTransaction({
      id: 5,
      connectorId: 1,
      tagId: "T",
      meterStart: 0,
      meterStop: null,
      startTime: new Date(),
      stopTime: null,
      meterSent: false,
    });
    const authorize = vi
      .spyOn(chargePoint, "authorizeAndWait")
      .mockResolvedValue("Accepted");
    expect(await reserve(1, 1)).toEqual({ status: "Occupied" });
    expect(authorize).not.toHaveBeenCalled();
  });
});
