import { SIGNING_CERTIFICATE } from "../../../cp/domain/security/__tests__/signingCertificateFixture";
import type { GoldenCase } from "./helpers";
import { c16, c201, PAST, selectFirmware, settle } from "./helpers";

export const optInCases: GoldenCase[] = [
  // --- opt-in lifecycles (#600, #601) ------------------------------------
  c201(
    "update-firmware-train",
    async (rig) => {
      // train on, a signature present: the whole 2.x train with requestId.
      await rig.csms.call("UpdateFirmware", {
        requestId: 9,
        firmware: {
          location: "https://fw.example.test/fw.bin",
          retrieveDateTime: PAST,
          signingCertificate: SIGNING_CERTIFICATE,
          signature: "sig",
        },
      });
      await rig.csms.waitForCall("SecurityEventNotification", {
        timeoutMs: 30_000,
      });
      await settle(rig);
    },
    { beforeConnect: (cp) => selectFirmware(cp, { train: true, stepMs: 40 }) },
  ),
  c201(
    "update-firmware-train-invalid-signature",
    async (rig) => {
      await rig.csms.call("UpdateFirmware", {
        requestId: 10,
        firmware: {
          location: "https://fw.example.test/fw.bin",
          retrieveDateTime: PAST,
          signingCertificate: SIGNING_CERTIFICATE,
          signature: "sig",
        },
      });
      await rig.csms.waitForCall("SecurityEventNotification", {
        timeoutMs: 30_000,
      });
      await settle(rig);
    },
    {
      beforeConnect: (cp) =>
        selectFirmware(cp, {
          train: true,
          stepMs: 40,
          failAt: "InvalidSignature",
        }),
    },
  ),
  c16(
    "update-firmware-reboot-before-installed",
    async (rig) => {
      await rig.csms.call("UpdateFirmware", {
        location: "http://fw.example.test/fw.bin",
        retrieveDate: PAST,
      });
      await rig.csms.waitForFrame(
        (f) =>
          f.dir === "CP>" &&
          f.action === "FirmwareStatusNotification" &&
          (f.payload as { status?: string }).status === "Installed",
        { timeoutMs: 30_000 },
      );
      await settle(rig);
    },
    {
      beforeConnect: (cp) =>
        selectFirmware(cp, { reboot: "beforeInstalled", stepMs: 40 }),
    },
  ),
  c201("get-log-replaced", async (rig) => {
    const getLog = (requestId: number) =>
      rig.csms.call("GetLog", {
        logType: "DiagnosticsLog",
        requestId,
        log: { remoteLocation: rig.uploadUrl() },
      });
    await getLog(31);
    await new Promise((r) => setTimeout(r, 300));
    await getLog(32);
    await new Promise((r) => setTimeout(r, 2600));
    await settle(rig);
  }),
];
