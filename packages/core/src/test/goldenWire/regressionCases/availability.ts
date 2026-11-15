// Regression cases: availability and reservations.
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import {
  both,
  c16,
  c201,
  changeAvail,
  charging,
  FUT,
  reserve,
  settle,
  two,
  wait,
} from "./helpers";

// --- availability
both(
  "avail-whole-two-connectors",
  async (r) => {
    await charging(r, "A", 1);
    await charging(r, "B", 2);
    await changeAvail(r, "Inoperative");
    await settle(r);
    r.cp.stopTransaction(1);
    await settle(r);
    await r.remoteStart("C", 1);
    r.cp.stopTransaction(2);
    await settle(r);
    await changeAvail(r, "Operative");
    await settle(r);
  },
  two,
);
both(
  "avail-one-busy",
  async (r) => {
    await charging(r, "A", 1);
    await changeAvail(r, "Inoperative");
    await settle(r);
    await r.remoteStart("B", 2);
    await settle(r);
    r.cp.stopTransaction(1);
    await settle(r);
    r.cp.stopTransaction(2);
    await settle(r);
  },
  two,
);
both("avail-flip-while-charging", async (r) => {
  await charging(r);
  await changeAvail(r, "Inoperative", 1);
  await settle(r);
  await changeAvail(r, "Operative", 1);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
  await changeAvail(r, "Inoperative", 1);
  await settle(r);
  await changeAvail(r, "Inoperative", 1);
  await settle(r);
});
// G03.FR.03 / G04.FR.04 for the station: the same state is Accepted during a
// transaction, and Operative drops the pending Inoperative.
c201("avail-station-same-state-while-charging", async (r) => {
  await charging(r);
  await changeAvail(r, "Operative");
  await settle(r);
  await changeAvail(r, "Inoperative");
  await settle(r);
  await changeAvail(r, "Operative");
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
});
both("avail-no-autoreset", async (r) => {
  r.cp.getConnector(1)!.autoResetToAvailable = false;
  await charging(r);
  await changeAvail(r, "Inoperative", 1);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
  await changeAvail(r, "Operative", 1);
  await settle(r);
});
both("avail-unknown", async (r) => {
  await changeAvail(r, "Inoperative", 9);
  await settle(r);
});
// --- reservations
both("res-other-tag-start", async (r) => {
  await reserve(r, 5, 1, "OWNER", FUT);
  await settle(r);
  await r.cp.startTransaction("OTHER", 1);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
  await r.csms.call("CancelReservation", { reservationId: 5 });
  await settle(r);
});
both("res-expire-lazy", async (r) => {
  await reserve(r, 6, 1, "OWNER", new Date(Date.now() + 700).toISOString());
  await settle(r);
  await wait(900);
  await r.cp.startTransaction("OWNER", 1);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
});
both("res-cancel-after-plug", async (r) => {
  await reserve(r, 7, 1, "OWNER", FUT);
  await settle(r);
  r.plugIn();
  await settle(r);
  await r.csms.call("CancelReservation", { reservationId: 7 });
  await settle(r);
  await r.csms.call("CancelReservation", { reservationId: 7 });
  await settle(r);
});
both("res-remote-start-reserved", async (r) => {
  await reserve(r, 8, 1, "OWNER", FUT);
  await settle(r);
  await r.remoteStart("OWNER");
  await r.remoteStop();
  await reserve(r, 9, 1, "OWNER", "2020-01-01T00:00:00.000Z");
  await settle(r);
  await reserve(r, 9, 1, "OWNER", FUT);
  await settle(r);
  await reserve(r, 9, 1, "OWNER2", FUT);
  await settle(r);
});
c16("res-connector0", async (r) => {
  await reserve(r, 10, 0, "OWNER", FUT);
  await settle(r);
});
// #595: connector 0 is accepted once the station supports it, and a ReserveNow
// with a held reservationId moves that reservation to the other connector.
c16("res-connector0-supported", async (r) => {
  r.cp.configuration.setRuntimeValue("ReserveConnectorZeroSupported", true);
  await reserve(r, 20, 0, "OWNER", FUT);
  await settle(r);
});
c16(
  "res-replace-moves-connector",
  async (r) => {
    await reserve(r, 21, 1, "OWNER", FUT);
    await settle(r);
    await reserve(r, 21, 2, "OWNER", FUT);
    await settle(r);
  },
  two,
);
// #595: a connector-0 reservation is its idTag's. A stranger starting on the
// other connector neither consumes it (no reservationId on that
// StartTransaction.req) nor cancels it; the owner's start does carry it.
c16(
  "res-connector0-stranger-starts",
  async (r) => {
    r.cp.configuration.setRuntimeValue("ReserveConnectorZeroSupported", true);
    await reserve(r, 22, 0, "OWNER", FUT);
    await settle(r);
    await r.remoteStart("STRANGER", 2);
    await settle(r);
    await r.remoteStart("OWNER", 1);
    await settle(r);
  },
  two,
);
// #595, 1.6 §5.13: a connector-0 reservation keeps one connector free for its
// idTag for its whole validity. A stranger takes the first of two connectors,
// is Rejected on the last one (RemoteStartTransaction.conf Rejected, no
// StartTransaction.req), and the owner still gets it, carrying the reservationId.
c16(
  "res-connector0-keeps-a-connector",
  async (r) => {
    r.cp.configuration.setRuntimeValue("ReserveConnectorZeroSupported", true);
    await reserve(r, 23, 0, "OWNER", FUT);
    await settle(r);
    await r.remoteStart("STRANGER", 1);
    await settle(r);
    await r.remoteStart("STRANGER2", 2);
    await settle(r);
    await r.remoteStart("OWNER", 2);
    await settle(r);
  },
  two,
);
both("res-then-inoperative", async (r) => {
  await reserve(r, 11, 1, "OWNER", FUT);
  await settle(r);
  await changeAvail(r, "Inoperative", 1);
  await settle(r);
  await r.csms.call("CancelReservation", { reservationId: 11 });
  await settle(r);
  await reserve(r, 12, 1, "OWNER", FUT);
  await settle(r);
});
// #731 / #712, 1.6 §5.13 and 2.0.1 H01.FR.16/17: a reserved connector that
// becomes Faulted loses its reservation (2.x reports Removed); after recovery a
// start carries no reservationId.
both("res-removed-faulted", async (r) => {
  await reserve(r, 13, 1, "OWNER", FUT);
  await settle(r);
  r.cp.updateConnectorStatus(1, OCPPStatus.Faulted);
  await settle(r);
  await r.csms.call("CancelReservation", { reservationId: 13 });
  await settle(r);
  r.cp.updateConnectorStatus(1, OCPPStatus.Available);
  await settle(r);
  await r.cp.startTransaction("OWNER", 1);
  await settle(r);
});
// #731 / #712: ChangeAvailability for the whole station ends every reservation.
both(
  "res-station-inoperative",
  async (r) => {
    await reserve(r, 14, 1, "OWNER", FUT);
    await settle(r);
    await reserve(r, 15, 2, "OWNER2", FUT);
    await settle(r);
    await changeAvail(r, "Inoperative");
    await settle(r);
    await r.csms.call("CancelReservation", { reservationId: 14 });
    await settle(r);
    await r.csms.call("CancelReservation", { reservationId: 15 });
    await settle(r);
  },
  two,
);
// #731 / #712: a reservation that names no connector ends with the station
// going Unavailable.
both(
  "res-unspecified-inoperative",
  async (r) => {
    r.cp.configuration.setRuntimeValue("ReserveConnectorZeroSupported", true);
    await reserve(r, 16, 0, "OWNER", FUT);
    await settle(r);
    await changeAvail(r, "Inoperative");
    await settle(r);
    await r.csms.call("CancelReservation", { reservationId: 16 });
    await settle(r);
  },
  two,
);
