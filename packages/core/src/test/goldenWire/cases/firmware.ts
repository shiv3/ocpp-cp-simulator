import { SIGNING_CERTIFICATE } from "../../../cp/domain/security/__tests__/signingCertificateFixture";
import type { GoldenCase } from "./helpers";
import { c16, c201, PAST, settle } from "./helpers";

export const firmwareCases: GoldenCase[] = [
  // --- firmware, diagnostics, logs --------------------------------------
  c16("update-firmware", async (rig) => {
    const from = rig.csms.mark();
    await rig.csms.call("UpdateFirmware", {
      location: "https://fw.example.test/fw.bin",
      retrieveDate: PAST,
    });
    await rig.csms.waitForFrame(
      (f) =>
        f.dir === "CP>" &&
        f.action === "FirmwareStatusNotification" &&
        (f.payload as { status?: string }).status === "Installed",
      { from, timeoutMs: 30_000 },
    );
    await settle(rig);
  }),
  c201("update-firmware", async (rig) => {
    await rig.csms.call("UpdateFirmware", {
      requestId: 7,
      firmware: {
        location: "https://fw.example.test/fw.bin",
        retrieveDateTime: PAST,
      },
    });
    await settle(rig);
    await new Promise((r) => setTimeout(r, 2600));
    await settle(rig);
  }),
  c201("update-firmware-simulated-failure-armed", async (rig) => {
    // 2.x UpdateFirmware stays ack-only even with the failure key armed.
    rig.cp.configuration.applyChange(
      "SimulatedFirmwareUpdateFailure",
      "DownloadFailed",
    );
    await rig.csms.call("UpdateFirmware", {
      requestId: 8,
      firmware: {
        location: "https://fw.example.test/fw.bin",
        retrieveDateTime: PAST,
      },
    });
    await settle(rig);
    await new Promise((r) => setTimeout(r, 2600));
    await settle(rig);
  }),
  c16("update-firmware-download-failed", async (rig) => {
    rig.cp.configuration.applyChange(
      "SimulatedFirmwareUpdateFailure",
      "DownloadFailed",
    );
    const from = rig.csms.mark();
    await rig.csms.call("UpdateFirmware", {
      location: "https://fw.example.test/fw.bin",
      retrieveDate: PAST,
    });
    await rig.csms.waitForFrame(
      (f) =>
        f.dir === "CP>" &&
        f.action === "FirmwareStatusNotification" &&
        (f.payload as { status?: string }).status === "DownloadFailed",
      { from, timeoutMs: 30_000 },
    );
    await settle(rig);
  }),
  c16("update-firmware-install-failed", async (rig) => {
    rig.cp.configuration.applyChange(
      "SimulatedFirmwareUpdateFailure",
      "InstallationFailed",
    );
    const from = rig.csms.mark();
    await rig.csms.call("UpdateFirmware", {
      location: "https://fw.example.test/fw.bin",
      retrieveDate: PAST,
    });
    await rig.csms.waitForFrame(
      (f) =>
        f.dir === "CP>" &&
        f.action === "FirmwareStatusNotification" &&
        (f.payload as { status?: string }).status === "InstallationFailed",
      { from, timeoutMs: 30_000 },
    );
    await settle(rig);
  }),
  c16("update-firmware-while-in-flight", async (rig) => {
    const from = rig.csms.mark();
    await rig.csms.call("UpdateFirmware", {
      location: "https://fw.example.test/a.bin",
      retrieveDate: PAST,
    });
    // The first download step is a zero-delay timer; wait for it so the second
    // request cannot race its notification.
    await rig.csms.waitForCall("FirmwareStatusNotification", {
      timeoutMs: 5_000,
    });
    await settle(rig);
    await rig.csms.call("UpdateFirmware", {
      location: "https://fw.example.test/b.bin",
      retrieveDate: PAST,
    });
    await rig.csms.waitForFrame(
      (f) =>
        f.dir === "CP>" &&
        f.action === "FirmwareStatusNotification" &&
        (f.payload as { status?: string }).status === "Installed",
      { from, timeoutMs: 30_000 },
    );
    await settle(rig);
  }),
  c16("signed-update-firmware", async (rig) => {
    const from = rig.csms.mark();
    await rig.csms.call("SignedUpdateFirmware", {
      requestId: 11,
      firmware: {
        location: "https://fw.example.test/signed.bin",
        retrieveDateTime: PAST,
        signingCertificate: SIGNING_CERTIFICATE,
        signature: "c2lnbmF0dXJl",
      },
    });
    await rig.csms.waitForFrame(
      (f) =>
        f.dir === "CP>" &&
        f.action === "SecurityEventNotification" &&
        (f.payload as { type?: string }).type === "FirmwareUpdated",
      { from, timeoutMs: 30_000 },
    );
    await settle(rig);
  }),
  // #733 L01.FR.23/24/02: a signing certificate that does not parse is
  // answered InvalidCertificate, followed by the security event, and no
  // train runs.
  c16("signed-update-firmware-invalid-certificate", async (rig) => {
    const from = rig.csms.mark();
    await rig.csms.call("SignedUpdateFirmware", {
      requestId: 12,
      firmware: {
        location: "https://fw.example.test/signed.bin",
        retrieveDateTime: PAST,
        signingCertificate:
          "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
        signature: "c2lnbmF0dXJl",
      },
    });
    await rig.csms.waitForFrame(
      (f) =>
        f.dir === "CP>" &&
        f.action === "SecurityEventNotification" &&
        (f.payload as { type?: string }).type ===
          "InvalidFirmwareSigningCertificate",
      { from, timeoutMs: 30_000 },
    );
    await settle(rig);
  }),
  c16("get-diagnostics", async (rig) => {
    const from = rig.csms.mark();
    await rig.csms.call("GetDiagnostics", { location: rig.uploadUrl() });
    await rig.csms.waitForFrame(
      (f) =>
        f.dir === "CP>" &&
        f.action === "DiagnosticsStatusNotification" &&
        ["Uploaded", "UploadFailed"].includes(
          (f.payload as { status?: string }).status ?? "",
        ),
      { from, timeoutMs: 30_000 },
    );
    await settle(rig);
  }),
  // 1.6 section 4.5 and security whitepaper L01.FR.28/29, N01.FR.12: a
  // triggered status reports the update or upload in progress, Idle otherwise.
  c16("trigger-status-while-busy", async (rig) => {
    const sentStatus =
      (action: string, status: string) =>
      (f: { dir: string; action?: string; payload?: unknown }) =>
        f.dir === "CP>" &&
        f.action === action &&
        (f.payload as { status?: string }).status === status;
    let from = rig.csms.mark();
    await rig.csms.call("SignedUpdateFirmware", {
      requestId: 12,
      firmware: {
        location: "https://fw.example.test/signed.bin",
        retrieveDateTime: PAST,
        signingCertificate: SIGNING_CERTIFICATE,
        signature: "c2lnbmF0dXJl",
      },
    });
    await rig.csms.waitForFrame(
      sentStatus("SignedFirmwareStatusNotification", "Downloaded"),
      { from, timeoutMs: 30_000 },
    );
    await rig.csms.call("ExtendedTriggerMessage", {
      requestedMessage: "FirmwareStatusNotification",
    });
    await settle(rig);
    from = rig.csms.mark();
    await rig.csms.waitForFrame(
      sentStatus("SignedFirmwareStatusNotification", "Installed"),
      { from, timeoutMs: 30_000 },
    );
    await settle(rig);
    await rig.csms.call("ExtendedTriggerMessage", {
      requestedMessage: "FirmwareStatusNotification",
    });
    await settle(rig);
    from = rig.csms.mark();
    await rig.csms.call("GetLog", {
      logType: "DiagnosticsLog",
      requestId: 22,
      log: { remoteLocation: rig.uploadUrl() },
    });
    await rig.csms.waitForFrame(
      sentStatus("LogStatusNotification", "Uploading"),
      {
        from,
        timeoutMs: 30_000,
      },
    );
    await rig.csms.call("ExtendedTriggerMessage", {
      requestedMessage: "LogStatusNotification",
    });
    await rig.csms.waitForFrame(
      sentStatus("LogStatusNotification", "Uploaded"),
      {
        from,
        timeoutMs: 30_000,
      },
    );
    await settle(rig);
    await rig.csms.call("ExtendedTriggerMessage", {
      requestedMessage: "LogStatusNotification",
    });
    await settle(rig);
  }),
  c16("get-log", async (rig) => {
    const from = rig.csms.mark();
    await rig.csms.call("GetLog", {
      logType: "DiagnosticsLog",
      requestId: 21,
      log: { remoteLocation: rig.uploadUrl() },
    });
    await rig.csms.waitForFrame(
      (f) =>
        f.dir === "CP>" &&
        f.action === "LogStatusNotification" &&
        ["Uploaded", "UploadFailure"].includes(
          (f.payload as { status?: string }).status ?? "",
        ),
      { from, timeoutMs: 30_000 },
    );
    await settle(rig);
  }),
  c201("get-log", async (rig) => {
    const from = rig.csms.mark();
    await rig.csms.call("GetLog", {
      logType: "DiagnosticsLog",
      requestId: 21,
      log: { remoteLocation: rig.uploadUrl() },
    });
    // The lifecycle's last status (N01.FR.09), not the 250 ms cut-off.
    await rig.csms.waitForFrame(
      (f) =>
        f.dir === "CP>" &&
        f.action === "LogStatusNotification" &&
        (f.payload as { status?: string }).status === "Uploaded",
      { from, timeoutMs: 30_000 },
    );
    await settle(rig);
  }),
  c201("firmware-and-log-status-driven", async (rig) => {
    await rig.csms.call("UpdateFirmware", {
      requestId: 5,
      firmware: {
        location: "https://fw.example.test/fw.bin",
        retrieveDateTime: PAST,
      },
    });
    rig.cp.sendFirmwareStatusNotification("Downloading");
    rig.cp.sendFirmwareStatusNotification("Installed");
    await rig.csms.call("GetLog", {
      logType: "SecurityLog",
      requestId: 6,
      log: { remoteLocation: rig.uploadUrl() },
    });
    rig.cp.sendLogStatusNotification("Uploading");
    rig.cp.sendLogStatusNotification("Uploaded");
    // Outlast the automatic lifecycle (2 s): the driven train is the only one
    // that ends with Uploaded (N01.FR.09, #822 review).
    await new Promise((resolve) => setTimeout(resolve, 2_600));
    await settle(rig);
  }),
];
