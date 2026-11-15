import type { GoldenCase } from "./helpers";
import { c16, c201, charging, settle, waitCall } from "./helpers";

export const resetCases: GoldenCase[] = [
  // --- reset -------------------------------------------------------------
  c16("reset-soft-idle", async (rig) => {
    await rig.csms.call("Reset", { type: "Soft" });
    await waitCall(rig, "BootNotification", 0, 2);
  }),
  c16("reset-hard-idle", async (rig) => {
    await rig.csms.call("Reset", { type: "Hard" });
    await waitCall(rig, "BootNotification", 0, 2);
  }),
  c16("reset-soft-charging", async (rig) => {
    await charging(rig);
    await rig.csms.call("Reset", { type: "Soft" });
    await waitCall(rig, "BootNotification", 0, 2);
  }),
  c16("reset-hard-charging", async (rig) => {
    await charging(rig);
    await rig.csms.call("Reset", { type: "Hard" });
    await waitCall(rig, "BootNotification", 0, 2);
  }),
  c201("reset-immediate-idle", async (rig) => {
    await rig.csms.call("Reset", { type: "Immediate" });
    await waitCall(rig, "BootNotification", 0, 2);
  }),
  // B01.FR.09: a reset the operator starts on the station is LocalReset.
  c201("reset-local", async (rig) => {
    rig.cp.reset();
    await waitCall(rig, "BootNotification", 0, 2);
  }),
  c201("reset-immediate-charging", async (rig) => {
    await charging(rig);
    await rig.csms.call("Reset", { type: "Immediate" });
    await waitCall(rig, "BootNotification", 0, 2);
  }),
  c201("reset-onidle-charging", async (rig) => {
    await charging(rig);
    await rig.csms.call("Reset", { type: "OnIdle" });
    await settle(rig);
    rig.cp.stopTransaction(1);
    await settle(rig);
  }),
];
