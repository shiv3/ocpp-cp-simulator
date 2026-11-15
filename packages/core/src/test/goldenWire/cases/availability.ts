import type { GoldenCase } from "./helpers";
import { both, c16, c201, charging, FUTURE, settle } from "./helpers";

export const availabilityCases: GoldenCase[] = [
  // --- availability ------------------------------------------------------
  ...both("change-availability-idle", async (rig) => {
    const change = (type: "Inoperative" | "Operative") =>
      rig.is16
        ? rig.csms.call("ChangeAvailability", { connectorId: 1, type })
        : rig.csms.call("ChangeAvailability", {
            operationalStatus: type,
            evse: { id: 1 },
          });
    await change("Inoperative");
    await settle(rig);
    await change("Operative");
    await settle(rig);
  }),
  ...both("change-availability-scheduled", async (rig) => {
    await charging(rig);
    const change = (type: "Inoperative" | "Operative") =>
      rig.is16
        ? rig.csms.call("ChangeAvailability", { connectorId: 1, type })
        : rig.csms.call("ChangeAvailability", {
            operationalStatus: type,
            evse: { id: 1 },
          });
    await change("Inoperative");
    await settle(rig);
    rig.cp.stopTransaction(1);
    await settle(rig);
    rig.unplug();
    await settle(rig);
    await change("Operative");
    await settle(rig);
  }),
  ...both(
    "change-availability-whole-station",
    async (rig) => {
      if (rig.is16) {
        await rig.csms.call("ChangeAvailability", {
          connectorId: 0,
          type: "Inoperative",
        });
        await settle(rig);
        await rig.csms.call("ChangeAvailability", {
          connectorId: 0,
          type: "Operative",
        });
      } else {
        await rig.csms.call("ChangeAvailability", {
          operationalStatus: "Inoperative",
        });
        await settle(rig);
        await rig.csms.call("ChangeAvailability", {
          operationalStatus: "Operative",
        });
      }
      await settle(rig);
    },
    { connectors: 2 },
  ),

  // --- reservation, unlock ----------------------------------------------
  c16("reserve-cancel", async (rig) => {
    await rig.csms.call("ReserveNow", {
      connectorId: 1,
      expiryDate: FUTURE,
      idTag: "TAG-RES",
      reservationId: 31,
    });
    await settle(rig);
    await rig.csms.call("CancelReservation", { reservationId: 31 });
    await settle(rig);
    await rig.csms.call("CancelReservation", { reservationId: 31 });
    await settle(rig);
  }),
  c201("reserve-cancel", async (rig) => {
    await rig.csms.call("ReserveNow", {
      id: 31,
      expiryDateTime: FUTURE,
      idToken: { idToken: "TAG-RES", type: "ISO14443" },
      evseId: 1,
    });
    await settle(rig);
    await rig.csms.call("CancelReservation", { reservationId: 31 });
    await settle(rig);
    await rig.csms.call("CancelReservation", { reservationId: 31 });
    await settle(rig);
  }),
  c16("reserve-then-use-reserved-tag", async (rig) => {
    await rig.csms.call("ReserveNow", {
      connectorId: 1,
      expiryDate: FUTURE,
      idTag: "TAG-RES",
      reservationId: 32,
    });
    await settle(rig);
    rig.plugIn();
    await settle(rig);
    await rig.startLocal("TAG-RES");
    rig.cp.stopTransaction(1);
    await settle(rig);
  }),
  c16("reserve-occupied", async (rig) => {
    await charging(rig);
    await rig.csms.call("ReserveNow", {
      connectorId: 1,
      expiryDate: FUTURE,
      idTag: "TAG-RES",
      reservationId: 33,
    });
    await settle(rig);
  }),
  ...both("unlock-connector", async (rig) => {
    await rig.csms.call(
      "UnlockConnector",
      rig.is16 ? { connectorId: 1 } : { evseId: 1, connectorId: 1 },
    );
    await settle(rig);
  }),
  ...both("unlock-connector-charging", async (rig) => {
    await charging(rig);
    await rig.csms.call(
      "UnlockConnector",
      rig.is16 ? { connectorId: 1 } : { evseId: 1, connectorId: 1 },
    );
    await settle(rig);
  }),
  ...both("unlock-unknown-connector", async (rig) => {
    await rig.csms.call(
      "UnlockConnector",
      rig.is16 ? { connectorId: 9 } : { evseId: 9, connectorId: 1 },
    );
    await settle(rig);
  }),
];
