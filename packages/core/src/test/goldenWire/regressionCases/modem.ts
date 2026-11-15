// Regression cases: modem identifiers from the installed SIM.

import { both, settle, wait } from "./helpers";

const SIM_ICCID = "8944501234567890123";
const SIM_IMSI = "310150123456789";
const withModem = (
  modem: NonNullable<
    import("../../../cp/domain/charge-point/ChargePoint").ChargePointTransportOptions["modem"]
  >,
) => ({
  transportOptions: { modem },
});
both(
  "sim-boot-reports-card",
  async (r) => {
    await settle(r);
  },
  withModem({ sim: { iccid: SIM_ICCID, imsi: SIM_IMSI, operator: "acme" } }),
);
both(
  "sim-boot-iccid-only-policy",
  async (r) => {
    await settle(r);
  },
  withModem({ reporting: "iccid", sim: { iccid: SIM_ICCID, imsi: SIM_IMSI } }),
);
both(
  "sim-boot-none-policy",
  async (r) => {
    await settle(r);
  },
  withModem({ reporting: "none", sim: { iccid: SIM_ICCID, imsi: SIM_IMSI } }),
);
both(
  "sim-boot-empty-slot",
  async (r) => {
    await settle(r);
  },
  withModem({}),
);
both(
  "sim-boot-suspended-card-still-reports",
  async (r) => {
    await settle(r);
  },
  withModem({ sim: { iccid: SIM_ICCID, subscription: "suspended" } }),
);
// A swap changes the next BootNotification and nothing else: no boot, no
// reset on its own. The reconnect that follows reports the new card (1.6
// boots on every connect; 2.x because the boot data changed, #702).
both(
  "sim-swap-then-reconnect",
  async (r) => {
    r.cp.modem!.replaceSim({
      iccid: "8900000000000000002",
      imsi: "310150000000002",
    });
    await wait(300);
    if (
      r.csms.frames.filter((f) => f.action === "BootNotification").length !== 1
    ) {
      throw new Error("a SIM swap must not send a BootNotification");
    }
    r.csms.dropConnection();
    await r.csms.waitForCall("BootNotification", { nth: 2, timeoutMs: 30000 });
    await settle(r);
  },
  withModem({ sim: { iccid: SIM_ICCID, imsi: SIM_IMSI } }),
);
// A subscription change leaves the identifiers alone: a 2.x reconnect still
// resumes without a BootNotification (#702); 1.6 boots on every connect.
both(
  "sim-suspend-then-reconnect",
  async (r) => {
    r.cp.modem!.suspendSubscription();
    r.csms.dropConnection();
    await r.reconnected();
    await settle(r);
  },
  withModem({ sim: { iccid: SIM_ICCID, imsi: SIM_IMSI } }),
);
