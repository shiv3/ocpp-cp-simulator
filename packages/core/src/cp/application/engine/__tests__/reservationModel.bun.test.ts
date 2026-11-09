// The reservation model of OCPP 2.0.1 and 2.1 (H01-H04, #709-#712) on the
// wire, against the fake CSMS of the golden wire test. The golden fixtures pin
// the 2.0.1 transcripts; this file runs the same rules on both 2.x versions.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Rig } from "../../../../test/goldenWire/rig";
import type { WireFrame } from "../../../../test/goldenWire/FakeCsms";
import { OCPPStatus } from "../../../domain/types/OcppTypes";

const FUT = "2099-01-01T00:00:00.000Z";
// A case lives on real sockets: under load it outlasts bun's 5 s default. The
// rig's own deadline comes first, so a stuck case says which frame it waited
// for instead of a bare "test timed out" (#874).
const CASE_DEADLINE_MS = 20_000;
setDefaultTimeout(30_000);
const rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((r) => r.dispose()));
});

async function rigFor(version: "2.0.1" | "2.1", connectors = 2) {
  const rig = await Rig.create({
    version,
    connectors,
    deadlineMs: CASE_DEADLINE_MS,
  });
  rigs.push(rig);
  await rig.csms.settle();
  return rig;
}

const reserve = (
  r: Rig,
  id: number,
  evseId: number | undefined,
  token: string,
  extra: Record<string, unknown> = {},
) =>
  r.csms.call("ReserveNow", {
    id,
    ...(evseId === undefined ? {} : { evseId }),
    expiryDateTime: FUT,
    idToken: { idToken: token, type: "ISO14443" },
    ...extra,
  });

const statusOf = (answer: WireFrame) =>
  (answer.payload as { status: string }).status;
const calls = (r: Rig, action: string) =>
  r.csms.frames.filter((f) => f.dir === "CP>" && f.action === action);
const connectorStatuses = (r: Rig, evseId: number) =>
  calls(r, "StatusNotification")
    .map((f) => f.payload as { evseId: number; connectorStatus: string })
    .filter((p) => p.evseId === evseId)
    .map((p) => p.connectorStatus);

describe.each(["2.0.1", "2.1"] as const)("OCPP %s reservations", (version) => {
  test("ReserveNow without evseId is Rejected unless NonEvseSpecific is true (H01.FR.19)", async () => {
    const r = await rigFor(version);
    const before = r.csms.frames.length;
    expect(statusOf(await reserve(r, 1, undefined, "A"))).toBe("Rejected");
    await r.csms.settle();
    expect(r.csms.frames.slice(before).map((f) => f.action)).toEqual([
      "ReserveNow",
      undefined,
    ]);
  });

  test("with NonEvseSpecific, EVSEs turn Reserved only when the reservations equal them (H01.FR.04/07/20)", async () => {
    const r = await rigFor(version);
    r.cp.configuration.setRuntimeValue("ReserveConnectorZeroSupported", true);
    expect(statusOf(await reserve(r, 1, undefined, "A"))).toBe("Accepted");
    await r.csms.settle();
    expect(connectorStatuses(r, 1)).toEqual(["Available"]);
    expect(statusOf(await reserve(r, 2, undefined, "B"))).toBe("Accepted");
    await r.csms.settle();
    expect(connectorStatuses(r, 1)).toEqual(["Available", "Reserved"]);
    expect(connectorStatuses(r, 2)).toEqual(["Available", "Reserved"]);
    expect(statusOf(await reserve(r, 3, undefined, "C"))).toBe("Occupied");

    // A stranger finds no EVSE; the token of reservation 2 uses either one.
    await r.cp.startTransaction("C", 2);
    expect(r.cp.getConnector(2)?.transaction ?? null).toBeNull();
    await r.cp.startTransaction("B", 2);
    await r.csms.settle();
    const started = calls(r, "TransactionEvent")
      .map((f) => f.payload as { eventType: string; reservationId?: number })
      .find((p) => p.eventType === "Started");
    expect(started?.reservationId).toBe(2);
    // Reservation 1 still needs an EVSE: the free one stays Reserved.
    expect(r.cp.getConnector(1)?.status).toBe(OCPPStatus.Reserved);
  });

  test("the same id replaces a reservation, also on another EVSE (H01.FR.02)", async () => {
    const r = await rigFor(version);
    expect(statusOf(await reserve(r, 5, 1, "A"))).toBe("Accepted");
    expect(statusOf(await reserve(r, 5, 2, "A"))).toBe("Accepted");
    await r.csms.settle();
    expect(connectorStatuses(r, 1)).toEqual([
      "Available",
      "Reserved",
      "Available",
    ]);
    expect(connectorStatuses(r, 2)).toEqual(["Available", "Reserved"]);
    expect(r.cp.reservationManager.getReservation(5)?.connectorId).toBe(2);
  });

  test("an EVSE that is not Available answers Occupied and keeps its status (H01.FR.11)", async () => {
    const r = await rigFor(version);
    r.plugIn(1);
    await r.csms.settle();
    expect(statusOf(await reserve(r, 6, 1, "A"))).toBe("Occupied");
    expect(statusOf(await reserve(r, 7, 2, "A"))).toBe("Accepted");
    expect(statusOf(await reserve(r, 8, 2, "B"))).toBe("Occupied");
    expect(r.cp.getConnector(1)?.status).toBe(OCPPStatus.Preparing);
  });

  test("another token cannot start on a reserved EVSE; the (group)IdToken can (H03.FR.01/04/09)", async () => {
    const r = await rigFor(version);
    await reserve(r, 9, 1, "OWNER", {
      groupIdToken: { idToken: "GROUP", type: "Central" },
    });
    await r.csms.settle();
    r.cp.authorization.seedCache([
      { idToken: "MEMBER", status: "Accepted", parentId: "GROUP" },
    ]);

    const refused = await r.cp.startTransaction("STRANGER", 1);
    expect(refused.started).toBe(false);
    expect(r.cp.getConnector(1)?.status).toBe(OCPPStatus.Reserved);
    expect(r.cp.reservationManager.getReservation(9)).toBeDefined();
    expect(calls(r, "TransactionEvent")).toHaveLength(0);

    expect((await r.cp.startTransaction("MEMBER", 1)).started).toBe(true);
    await r.csms.settle();
    const started = calls(r, "TransactionEvent")[0].payload as {
      reservationId?: number;
    };
    expect(started.reservationId).toBe(9);
    expect(r.cp.reservationManager.getReservation(9)).toBeUndefined();
  });

  test("expiry sends ReservationStatusUpdate(Expired), then the Available status (H04.FR.01/03)", async () => {
    const r = await rigFor(version);
    await r.csms.call("ReserveNow", {
      id: 10,
      evseId: 1,
      expiryDateTime: new Date(Date.now() + 400).toISOString(),
      idToken: { idToken: "A", type: "ISO14443" },
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    await r.csms.settle();
    const tail = r.csms.frames
      .filter((f) => f.dir === "CP>" && f.kind === "call")
      .slice(-2);
    expect(tail.map((f) => f.action)).toEqual([
      "ReservationStatusUpdate",
      "StatusNotification",
    ]);
    expect(tail[0].payload).toEqual({
      reservationId: 10,
      reservationUpdateStatus: "Expired",
    });
    expect(tail[1].payload).toMatchObject({ connectorStatus: "Available" });
  });

  test("a reserved EVSE that turns Faulted or Unavailable reports Removed (H01.FR.16/17)", async () => {
    const r = await rigFor(version);
    await reserve(r, 11, 1, "A");
    await reserve(r, 12, 2, "B");
    await r.csms.settle();
    r.cp.updateConnectorStatus(1, OCPPStatus.Faulted);
    await r.csms.call("ChangeAvailability", {
      operationalStatus: "Inoperative",
      evse: { id: 2 },
    });
    await r.csms.settle();
    const updates = calls(r, "ReservationStatusUpdate").map((f) => f.payload);
    expect(updates).toEqual([
      { reservationId: 11, reservationUpdateStatus: "Removed" },
      { reservationId: 12, reservationUpdateStatus: "Removed" },
    ]);
    expect(r.cp.reservationManager.getAllReservations()).toEqual([]);
  });

  test("an offline station drops the update like a StatusNotification", async () => {
    const r = await rigFor(version);
    await reserve(r, 13, 1, "A");
    await r.csms.settle();
    r.csms.dropConnection();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = calls(r, "ReservationStatusUpdate").length;
    r.cp.updateConnectorStatus(1, OCPPStatus.Faulted);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(r.cp.reservationManager.getReservation(13)).toBeUndefined();
    expect(calls(r, "ReservationStatusUpdate")).toHaveLength(before);
  });
});

describe("OCPP 1.6 sends no ReservationStatusUpdate", () => {
  test("a reservation that ends by a fault is silent on the wire", async () => {
    const r = await Rig.create({
      version: "1.6",
      connectors: 1,
      deadlineMs: CASE_DEADLINE_MS,
    });
    rigs.push(r);
    await r.csms.settle();
    await r.csms.call("ReserveNow", {
      connectorId: 1,
      expiryDate: FUT,
      idTag: "A",
      reservationId: 1,
    });
    r.cp.updateConnectorStatus(1, OCPPStatus.Faulted);
    await r.csms.settle();
    expect(calls(r, "ReservationStatusUpdate")).toHaveLength(0);
    expect(r.cp.reservationManager.getAllReservations()).toEqual([]);
  });
});
