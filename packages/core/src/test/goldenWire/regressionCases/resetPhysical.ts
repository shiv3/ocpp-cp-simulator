// Regression cases: reset, unlock and physical-state cases.
/* eslint-disable @typescript-eslint/no-explicit-any --
   these cases reach into station internals (configuration, listeners, runtime
   snapshots) that the public types do not expose */
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import { both, c16, c201, cfg, charging, settle, two, wait } from "./helpers";

// --- reset
c16(
  "reset-soft-two",
  async (r) => {
    await charging(r, "A", 1);
    await charging(r, "B", 2);
    await r.csms.call("Reset", { type: "Soft" });
    await wait(1500);
    await settle(r);
  },
  two,
);
c16(
  "reset-hard-two",
  async (r) => {
    await charging(r, "A", 1);
    await charging(r, "B", 2);
    await r.csms.call("Reset", { type: "Hard" });
    await r.csms.waitForCall("BootNotification", { nth: 2, timeoutMs: 30000 });
    await settle(r);
  },
  two,
);
c201(
  "reset-evse",
  async (r) => {
    await charging(r, "A", 1);
    await charging(r, "B", 2);
    await r.csms.call("Reset", { type: "Immediate", evseId: 2 });
    await wait(600);
    await settle(r);
    await r.csms.call("Reset", { type: "OnIdle", evseId: 1 });
    await r.csms.call("Reset", { type: "OnIdle", evseId: 2 });
    await wait(600);
    await settle(r);
    await r.csms.call("Reset", { type: "Immediate", evseId: 9 });
    await settle(r);
  },
  two,
);
// #635: a Reset OnIdle answered Scheduled boots once the last targeted
// transaction ended; nothing running answers Accepted and boots at once; an
// Immediate reset drops the pending one.
c201("reset-onidle-idle", async (r) => {
  await r.csms.call("Reset", { type: "OnIdle" });
  await wait(600);
  await settle(r);
});
c201(
  "reset-onidle-waits-for-last",
  async (r) => {
    await charging(r, "A", 1);
    await charging(r, "B", 2);
    await r.csms.call("Reset", { type: "OnIdle" });
    await settle(r);
    r.cp.stopTransaction(1);
    await wait(600);
    await settle(r);
    r.cp.stopTransaction(2);
    await wait(600);
    await settle(r);
  },
  two,
);
c201("reset-onidle-then-immediate", async (r) => {
  await charging(r);
  await r.csms.call("Reset", { type: "OnIdle" });
  await settle(r);
  await r.csms.call("Reset", { type: "Immediate" });
  await wait(600);
  await settle(r);
  await charging(r, "B");
  r.cp.stopTransaction(1);
  await wait(600);
  await settle(r);
});
c201("reset-immediate-resume", async (r) => {
  await charging(r);
  await r.csms.call("Reset", { type: "ImmediateAndResume" });
  await wait(600);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
});
// --- unlock
both("unlock-failed-with-tx", async (r) => {
  await charging(r);
  (r.cp.getConnector(1) as any).unlockResponse = "UnlockFailed";
  const p = r.is16 ? { connectorId: 1 } : { evseId: 1, connectorId: 1 };
  await r.csms.call("UnlockConnector", p);
  await settle(r);
  await r.csms.call("UnlockConnector", p);
  await settle(r);
});
// --- physical
both("ev-side-disconnect-keep", async (r) => {
  cfg(r, "StopTransactionOnEVSideDisconnect", "false");
  await charging(r);
  (r.cp as any).evDisconnected(1);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
});
both("ev-side-disconnect-stop", async (r) => {
  cfg(r, "StopTransactionOnEVSideDisconnect", "true");
  await charging(r);
  (r.cp as any).evDisconnected(1);
  await settle(r);
});
both("connection-timeout", async (r) => {
  cfg(r, "ConnectionTimeOut", "1");
  r.plugIn();
  await wait(1500);
  await settle(r);
  r.plugIn();
  await settle(r);
  await r.remoteStart("T");
  await wait(1500);
  await settle(r);
});
both("back-to-back", async (r) => {
  await charging(r);
  r.cp.stopTransaction(1);
  await settle(r);
  await charging(r, "TAG-2");
  r.cp.stopTransaction(1, "Local");
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
});
both("sync-start-stop", async (r) => {
  r.plugIn();
  await settle(r);
  const p = r.cp.startTransaction("A", 1);
  r.cp.stopTransaction(1, "EmergencyStop");
  await p;
  const q = r.cp.startTransaction("B", 1);
  await q;
  await settle(r);
  r.cp.stopTransaction(1, "PowerLoss");
  await settle(r);
});
both("clean-then-start", async (r) => {
  await charging(r);
  r.cp.cleanTransaction(1);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
  await r.cp.startTransaction("B", 1);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
});
both("nested-stop-in-listener", async (r) => {
  let done = false;
  r.cp.events.on("connectorStatusChange", (e: any) => {
    if (e.status === OCPPStatus.Charging && !done) {
      done = true;
      r.cp.stopTransaction(1, "Other");
    }
  });
  await charging(r);
  await settle(r);
});
both("nested-start-on-preparing", async (r) => {
  let done = false;
  r.cp.events.on("connectorStatusChange", (e: any) => {
    if (e.status === OCPPStatus.Preparing && !done) {
      done = true;
      void r.cp.startTransaction("N", 1);
    }
  });
  r.plugIn();
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
});
both("transaction-started-listener-stops", async (r) => {
  r.cp.events.on("transactionStarted", () => r.cp.stopTransaction(1, "Other"));
  r.plugIn();
  await settle(r);
  await r.cp.startTransaction("N", 1);
  await settle(r);
});
both("soc-start", async (r) => {
  r.plugIn();
  await settle(r);
  await r.cp.startTransaction("A", 1, 50, 20);
  await settle(r);
  r.cp.updateConnectorStatus(1, OCPPStatus.Charging);
  (r.cp as any).sendMeterValue?.(1);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
  await r.cp.startTransaction("B", 1);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
});
both("offline-start-stop", async (r) => {
  r.plugIn();
  await settle(r);
  r.cp.disconnect();
  await wait(200);
  await r.cp.startTransaction("OFF", 1);
  await wait(100);
  r.cp.stopTransaction(1);
  await wait(100);
  await r.connectAndBoot();
  await settle(r);
});
both("offline-mid-tx-reconnect", async (r) => {
  await charging(r);
  r.csms.dropConnection();
  await r.reconnected();
  await settle(r);
  await r.remoteStop();
  await settle(r);
});
both("disconnect-with-remote-stop-noack", async (r) => {
  await charging(r);
  const id = r.transactionId(1);
  void (r.is16
    ? r.csms.callNoWait("RemoteStopTransaction", { transactionId: id })
    : r.csms.callNoWait("RequestStopTransaction", { transactionId: id }));
  r.csms.dropConnection();
  await r.reconnected();
  await settle(r);
});
