// Regression cases: reservations and group tags.
/* eslint-disable @typescript-eslint/no-explicit-any --
   these cases reach into station internals (configuration, listeners, runtime
   snapshots) that the public types do not expose */
import { c16, c201, c21, FUT, reserve, settle, two } from "./helpers";

// #721 / #711, 1.6 §5.13 and 2.0.1 H03.FR.04: a tag of another group is refused
// (nothing but the Authorize on the wire, the reservation stays); a tag whose
// parent idTag / groupIdToken is the reservation's starts and carries the
// reservation id.
const groupResponders = {
  "1.6": {
    Authorize: (p: any) => ({
      idTagInfo: {
        status: "Accepted",
        ...(p.idTag === "MEMBER" ? { parentIdTag: "GROUP" } : {}),
      },
    }),
  },
  "2.0.1": {
    Authorize: (p: any) => ({
      idTokenInfo: {
        status: "Accepted",
        ...(p.idToken.idToken === "MEMBER"
          ? { groupIdToken: { idToken: "GROUP", type: "Central" } }
          : {}),
      },
    }),
  },
};
for (const version of ["1.6", "2.0.1"] as const) {
  (version === "1.6" ? c16 : c201)(
    "res-parent-start",
    async (r) => {
      if (r.is16) {
        await r.csms.call("ReserveNow", {
          connectorId: 1,
          expiryDate: FUT,
          idTag: "OWNER",
          parentIdTag: "GROUP",
          reservationId: 17,
        });
      } else {
        await r.csms.call("ReserveNow", {
          id: 17,
          evseId: 1,
          expiryDateTime: FUT,
          idToken: { idToken: "OWNER", type: "ISO14443" },
          groupIdToken: { idToken: "GROUP", type: "Central" },
        });
      }
      await settle(r);
      await r.cp.startTransaction("STRANGER", 1);
      await settle(r);
      await r.cp.startTransaction("MEMBER", 1);
      await settle(r);
      r.cp.stopTransaction(1);
      await settle(r);
    },
    { responders: groupResponders[version] },
  );
}
// F01.FR.21/22: a RequestStartTransaction whose groupIdToken is the
// reservation's group starts on the reserved EVSE with the reservation id,
// also when the station does not know the token's group (a Central token is
// never sent to Authorize) (#818, #660).
for (const [, add] of [
  ["2.0.1", c201],
  ["2.1", c21],
] as const) {
  add("res-request-start-group", async (r) => {
    await r.csms.call("ReserveNow", {
      id: 19,
      evseId: 1,
      expiryDateTime: FUT,
      idToken: { idToken: "OWNER", type: "ISO14443" },
      groupIdToken: { idToken: "GROUP", type: "Central" },
    });
    await settle(r);
    await r.csms.call("RequestStartTransaction", {
      idToken: { idToken: "MEMBER", type: "Central" },
      groupIdToken: { idToken: "GROUP", type: "Central" },
      remoteStartId: 5,
      evseId: 1,
    });
    await settle(r);
    await r.remoteStop();
    await settle(r);
  });
}
// #721, 1.6 §5.13: a RemoteStartTransaction for another tag on a reserved
// connector answers Rejected; the reservation stays.
c16("res-remote-start-other-tag", async (r) => {
  await reserve(r, 18, 1, "OWNER", FUT);
  await settle(r);
  await r.remoteStart("OTHER");
  await r.csms.call("CancelReservation", { reservationId: 18 });
  await settle(r);
});
// #710, 2.0.1 H01.FR.02: the same id again replaces the reservation, also on
// another EVSE, which goes back to Available.
c201(
  "res-replace-moves-evse",
  async (r) => {
    await reserve(r, 21, 1, "OWNER", FUT);
    await settle(r);
    await reserve(r, 21, 2, "OWNER", FUT);
    await settle(r);
  },
  two,
);
// #710, H01.FR.11: an EVSE that is not Available (a cable plugged in, or
// reserved under another id) answers Occupied and keeps its status.
c201(
  "res-occupied-not-available",
  async (r) => {
    r.plugIn(1);
    await settle(r);
    await reserve(r, 24, 1, "OWNER", FUT);
    await settle(r);
    await reserve(r, 25, 2, "OWNER", FUT);
    await settle(r);
    await reserve(r, 26, 2, "OWNER2", FUT);
    await settle(r);
  },
  two,
);
// #709, H01.FR.19: without ReservationCtrlr.NonEvseSpecific a ReserveNow
// without evseId is Rejected.
c201("res-unspecified-rejected", async (r) => {
  await reserve(r, 27, 0, "OWNER", FUT);
  await settle(r);
});
// #709, H01.FR.04/07/20: with it, reservations are taken while an EVSE stays
// free for each; the EVSEs report Reserved once the reservations equal them,
// and a token's session consumes its reservation on any EVSE.
c201(
  "res-unspecified-supported",
  async (r) => {
    r.cp.configuration.setRuntimeValue("ReserveConnectorZeroSupported", true);
    await reserve(r, 28, 0, "OWNER", FUT);
    await settle(r);
    await reserve(r, 29, 0, "OWNER2", FUT);
    await settle(r);
    await reserve(r, 30, 0, "OWNER3", FUT);
    await settle(r);
    await r.cp.startTransaction("STRANGER", 2);
    await settle(r);
    await r.cp.startTransaction("OWNER2", 2);
    await settle(r);
  },
  two,
);
