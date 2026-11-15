// Regression cases: 1.6 security events and power loss.

import type { Rig } from "../rig";
import { both, c16, charging, settle, wait } from "./helpers";

// --- 1.6 security events (#734, whitepaper A04.FR.01/02) -------------------
// With SecurityProfile >= 1 the station reports its startup and resets.
const profile1 = (cp: {
  configuration: {
    applyChange: (
      k: string,
      v: string,
      o?: { bypassGuard?: boolean },
    ) => unknown;
  };
}) => {
  // Profile 1 needs the AuthorizationKey the transport sends (#724, §7.2).
  cp.configuration.applyChange(
    "AuthorizationKey",
    "00112233445566778899aabbccddeeff",
  );
  // The case sets the starting profile; the A05 guard is for CSMS requests.
  cp.configuration.applyChange("SecurityProfile", "1", { bypassGuard: true });
};
const resetCase = (type: "Soft" | "Hard") => async (r: Rig) => {
  await r.csms.call("Reset", { type });
  await r.csms.waitForCall("BootNotification", { nth: 2, timeoutMs: 30000 });
  await wait(300);
  await settle(r);
};
// A Reset ends with the boot, then ResetOrReboot, then StartupOfTheDevice.
c16("reset-soft-security-events", resetCase("Soft"), {
  beforeConnect: profile1,
});
c16("reset-hard-security-events", resetCase("Hard"), {
  beforeConnect: profile1,
});
// A reconnect after a dropped socket, and an accepted TriggerMessage of a
// BootNotification, do not report a device startup that did not happen.
c16(
  "reconnect-no-startup-event",
  async (r) => {
    r.csms.dropConnection();
    await r.csms.waitForCall("BootNotification", { nth: 2, timeoutMs: 30000 });
    await wait(300);
    await r.csms.call("TriggerMessage", {
      requestedMessage: "BootNotification",
    });
    await r.csms.waitForCall("BootNotification", { nth: 3, timeoutMs: 30000 });
    await wait(300);
    await settle(r);
  },
  { beforeConnect: profile1 },
);
// Power returning is a start of the device (A04.FR.01): the Accepted boot
// after a power loss reports StartupOfTheDevice again (#734).
c16(
  "power-restore-startup-event",
  async (r) => {
    r.cp.powerLoss();
    await wait(300);
    r.cp.restorePower();
    await r.csms.waitForCall("BootNotification", { nth: 2, timeoutMs: 30000 });
    await wait(300);
    await settle(r);
  },
  { beforeConnect: profile1 },
);
// A critical event raised while disconnected is delivered after the next
// Accepted boot with the timestamp it was raised with.
c16(
  "security-event-queued-offline",
  async (r) => {
    r.cp.disconnect();
    await wait(200);
    const raisedAt = Date.now();
    await r.cp.sendSecurityEventNotification(
      "TamperDetectionActivated",
      "case",
    );
    // A non-critical type is not kept.
    await r.cp.sendSecurityEventNotification("InvalidMessages", "case");
    await wait(1200);
    await r.connectAndBoot();
    await wait(300);
    const sent = r.csms.frames.find(
      (f) =>
        f.dir === "CP>" &&
        f.action === "SecurityEventNotification" &&
        (f.payload as { type?: string }).type === "TamperDetectionActivated",
    );
    const stamp = Date.parse(
      (sent?.payload as { timestamp?: string }).timestamp ?? "",
    );
    if (!(stamp >= raisedAt - 1000 && stamp <= raisedAt + 500)) {
      throw new Error(
        `the queued event lost its timestamp (${stamp} vs ${raisedAt})`,
      );
    }
    await settle(r);
  },
  { beforeConnect: profile1 },
);
// #455 power loss: the socket vanishes with the transaction still running;
// after the power returns the station boots, then resumes (the default) or
// reports the transaction ended with reason PowerLoss (1.6 StopTransaction;
// 2.x E17.FR.21 Ended + AbnormalCondition), stamped with the loss.
both("power-loss-resume", async (r) => {
  await charging(r);
  r.cp.powerLoss();
  await wait(300);
  r.cp.restorePower({ transactions: "resume" });
  await r.csms.waitForCall("BootNotification", { nth: 2, timeoutMs: 30000 });
  await settle(r);
});
both("power-loss-end", async (r) => {
  await charging(r);
  r.cp.powerLoss();
  await wait(300);
  r.cp.restorePower({ transactions: "end" });
  await r.csms.waitForCall("BootNotification", { nth: 2, timeoutMs: 30000 });
  await settle(r);
});
// Messages queued before the loss go first, then the recovery.
both("power-loss-queued-then-end", async (r) => {
  await charging(r);
  r.cp.disconnect();
  await wait(200);
  r.cp.setMeterValue(1, 500);
  // 1.x: MeterValues; 2.x: TransactionEvent(Updated), queued as offline.
  r.cp.txUpdatedMeterValues = true;
  r.cp.sendScheduledMeterValue(1);
  await wait(100);
  r.cp.powerLoss();
  await wait(300);
  r.cp.restorePower({ transactions: "end" });
  await r.csms.waitForCall("BootNotification", { nth: 2, timeoutMs: 30000 });
  await settle(r);
});

// #929: BootNotification modem identifiers come from the installed SIM when a
// modem model is configured; without one the static boot data is untouched
// (every case above keeps its bytes). Absent identifiers are omitted, never
// sent as placeholders.
