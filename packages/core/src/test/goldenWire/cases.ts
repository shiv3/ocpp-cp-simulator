import { OCPPStatus } from "../../cp/domain/types/OcppTypes";
import type { WireVersion } from "./FakeCsms";
import type { Rig, RigOptions } from "./rig";

/** One scripted run of a real ChargePoint against the fake CSMS. */
export interface GoldenCase {
  /** Fixture file name; unique across versions. */
  readonly name: string;
  readonly version: WireVersion;
  readonly options?: Partial<Omit<RigOptions, "version">>;
  readonly run: (rig: Rig) => Promise<void>;
}

const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";

const c16 = (
  name: string,
  run: GoldenCase["run"],
  options?: GoldenCase["options"],
): GoldenCase => ({ name: `16-${name}`, version: "1.6", run, options });
const c201 = (
  name: string,
  run: GoldenCase["run"],
  options?: GoldenCase["options"],
): GoldenCase => ({ name: `201-${name}`, version: "2.0.1", run, options });

/** A case that exists on both versions with one body. */
const both = (
  name: string,
  run: GoldenCase["run"],
  options?: GoldenCase["options"],
): GoldenCase[] => [c16(name, run, options), c201(name, run, options)];

const settle = (rig: Rig) => rig.csms.settle();

async function charging(rig: Rig, tag = "TAG-1"): Promise<void> {
  rig.plugIn();
  await settle(rig);
  await rig.startLocal(tag);
}

/** Wait for a CP-initiated frame that follows an action, then let it settle. */
async function waitCall(
  rig: Rig,
  action: string,
  from: number,
  nth = 1,
): Promise<void> {
  let seen = 0;
  await rig.csms.waitForFrame(
    (f) => {
      if (f.dir === "CP>" && f.action === action) return ++seen === nth;
      return false;
    },
    { from, timeoutMs: 30_000 },
  );
  await settle(rig);
}

export const goldenCases: GoldenCase[] = [
  // --- boot and status --------------------------------------------------
  ...both("boot", async () => undefined),
  ...both("boot-two-connectors", async () => undefined, { connectors: 2 }),
  ...both(
    "boot-pending-then-triggered",
    async (rig) => {
      // Pending sends nothing more by itself; the CSMS moves the station on
      // with TriggerMessage(BootNotification), which is allowed while Pending.
      await settle(rig);
      rig.cp.sendHeartbeat();
      await settle(rig);
      await rig.csms.call("TriggerMessage", {
        requestedMessage: "BootNotification",
      });
      await rig.csms.waitForCall("BootNotification", {
        nth: 2,
        timeoutMs: 30_000,
      });
      await settle(rig);
    },
    {
      responders: {
        BootNotification: (_p, { nth }) => ({
          result: {
            status: nth === 1 ? "Pending" : "Accepted",
            currentTime: "2030-01-01T00:00:00.000Z",
            interval: 3600,
          },
        }),
      },
    },
  ),
  ...both(
    "boot-rejected-then-retry",
    async (rig) => {
      await rig.csms.waitForCall("BootNotification", {
        nth: 2,
        timeoutMs: 30_000,
      });
      await settle(rig);
    },
    {
      responders: {
        BootNotification: (_p, { nth }) => ({
          result: {
            status: nth === 1 ? "Rejected" : "Accepted",
            currentTime: "2030-01-01T00:00:00.000Z",
            interval: nth === 1 ? 1 : 3600,
          },
        }),
      },
    },
  ),
  ...both(
    "boot-rejected",
    async (rig) => {
      await settle(rig);
    },
    {
      responders: {
        BootNotification: () => ({
          result: {
            status: "Rejected",
            currentTime: "2030-01-01T00:00:00.000Z",
            interval: 3600,
          },
        }),
      },
    },
  ),
  ...both("status-walk", async (rig) => {
    for (const s of [
      OCPPStatus.Preparing,
      OCPPStatus.Charging,
      OCPPStatus.SuspendedEV,
      OCPPStatus.SuspendedEVSE,
      OCPPStatus.Finishing,
      OCPPStatus.Available,
      OCPPStatus.Faulted,
      OCPPStatus.Available,
      OCPPStatus.Unavailable,
      OCPPStatus.Available,
    ]) {
      rig.cp.updateConnectorStatus(1, s);
      await settle(rig);
    }
  }),
  ...both("heartbeat", async (rig) => {
    rig.cp.sendHeartbeat();
    await settle(rig);
  }),
  ...both("trigger-message-all", async (rig) => {
    const t = rig.is16
      ? (m: string) =>
          rig.csms.call("TriggerMessage", {
            requestedMessage: m,
            ...(m === "StatusNotification" || m === "MeterValues"
              ? { connectorId: 1 }
              : {}),
          })
      : (m: string) =>
          rig.csms.call("TriggerMessage", {
            requestedMessage: m,
            ...(m === "StatusNotification" || m === "MeterValues"
              ? { evse: { id: 1, connectorId: 1 } }
              : {}),
          });
    const messages = rig.is16
      ? [
          "BootNotification",
          "Heartbeat",
          "StatusNotification",
          "MeterValues",
          "FirmwareStatusNotification",
          "DiagnosticsStatusNotification",
        ]
      : [
          "BootNotification",
          "Heartbeat",
          "StatusNotification",
          "MeterValues",
          "FirmwareStatusNotification",
          "LogStatusNotification",
          "SignChargingStationCertificate",
        ];
    for (const m of messages) {
      await t(m);
      await settle(rig);
    }
  }),
  ...both("trigger-message-unsupported", async (rig) => {
    await rig.csms.call("TriggerMessage", {
      requestedMessage: "NoSuchMessage",
    });
    await settle(rig);
  }),

  // --- authorize and transactions ---------------------------------------
  ...both("authorize", async (rig) => {
    rig.cp.authorize("TAG-AUTH");
    await settle(rig);
  }),
  ...both(
    "authorize-invalid",
    async (rig) => {
      rig.cp.authorize("CERT023-INV");
      await settle(rig);
    },
    {
      responders: {
        Authorize: (p) => ({
          result: rig16or201(p),
        }),
      },
    },
  ),
  ...both("local-start-stop", async (rig) => {
    await charging(rig);
    rig.cp.stopTransaction(1);
    await settle(rig);
    rig.unplug();
    await settle(rig);
  }),
  ...both("local-start-meter-stop", async (rig) => {
    await charging(rig);
    rig.cp.setMeterValue(1, 1500);
    rig.cp.sendMeterValue(1);
    await settle(rig);
    rig.cp.setMeterValue(1, 4200);
    rig.cp.sendMeterValue(1);
    await settle(rig);
    rig.cp.stopTransaction(1, "Local");
    await settle(rig);
  }),
  ...both(
    "start-denied-by-authorize",
    async (rig) => {
      rig.plugIn();
      await settle(rig);
      await rig.cp.startTransaction("CERT023-INV", 1);
      await settle(rig);
    },
    {
      responders: {
        Authorize: (p) => ({ result: rig16or201(p) }),
        StartTransaction: () => ({
          result: {
            transactionId: 9001,
            idTagInfo: { status: "Invalid" },
          },
        }),
      },
    },
  ),
  ...both("remote-start-stop", async (rig) => {
    rig.plugIn();
    await settle(rig);
    await rig.remoteStart();
    await rig.remoteStop();
    rig.unplug();
    await settle(rig);
  }),
  ...both("remote-start-no-plug", async (rig) => {
    await rig.remoteStart();
    await rig.remoteStop();
  }),
  ...both("remote-stop-unknown-transaction", async (rig) => {
    if (rig.is16) {
      await rig.csms.call("RemoteStopTransaction", { transactionId: 424242 });
    } else {
      await rig.csms.call("RequestStopTransaction", {
        transactionId: "no-such-transaction",
      });
    }
    await settle(rig);
  }),
  ...both("ev-disconnect-during-transaction", async (rig) => {
    await charging(rig);
    rig.cp.evDisconnected(1);
    await settle(rig);
  }),
  ...both(
    "two-connectors-transactions",
    async (rig) => {
      rig.plugIn(1);
      rig.plugIn(2);
      await settle(rig);
      await rig.startLocal("TAG-A", 1);
      await rig.startLocal("TAG-B", 2);
      rig.cp.setMeterValue(1, 100);
      rig.cp.sendMeterValue(1);
      rig.cp.setMeterValue(2, 200);
      rig.cp.sendMeterValue(2);
      await settle(rig);
      rig.cp.stopTransaction(2);
      await settle(rig);
      rig.cp.stopTransaction(1);
      await settle(rig);
    },
    { connectors: 2 },
  ),
  ...both("meter-value-no-transaction", async (rig) => {
    rig.cp.setMeterValue(1, 777);
    rig.cp.sendMeterValue(1);
    await settle(rig);
  }),

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
        signingCertificate:
          "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
        signature: "c2lnbmF0dXJl",
      },
    });
    await rig.csms.waitForFrame(
      (f) =>
        f.dir === "CP>" &&
        f.action === "SignedFirmwareStatusNotification" &&
        (f.payload as { status?: string }).status === "Installed",
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
    await rig.csms.call("GetLog", {
      logType: "DiagnosticsLog",
      requestId: 21,
      log: { remoteLocation: rig.uploadUrl() },
    });
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
    await settle(rig);
  }),

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

  // --- inbound policy and response override ----------------------------
  ...both("inbound-policy-callerror", async (rig) => {
    rig.cp.setInboundCallPolicy("UnlockConnector", {
      kind: "callerror",
      errorCode: "NotSupported",
      errorDescription: "policy says no",
    });
    await rig.csms.call(
      "UnlockConnector",
      rig.is16 ? { connectorId: 1 } : { evseId: 1, connectorId: 1 },
    );
    await settle(rig);
    rig.cp.clearInboundCallPolicy("UnlockConnector");
    await rig.csms.call(
      "UnlockConnector",
      rig.is16 ? { connectorId: 1 } : { evseId: 1, connectorId: 1 },
    );
    await settle(rig);
  }),
  ...both("inbound-policy-ignore", async (rig) => {
    rig.cp.setInboundCallPolicy("TriggerMessage", { kind: "ignore" });
    rig.csms.callNoWait(
      "TriggerMessage",
      rig.is16
        ? { requestedMessage: "Heartbeat" }
        : { requestedMessage: "Heartbeat" },
    );
    await settle(rig);
  }),
  ...both("response-override", async (rig) => {
    rig.cp.armResponseOverride("UnlockConnector", "Failed");
    const payload = rig.is16
      ? { connectorId: 1 }
      : { evseId: 1, connectorId: 1 };
    await rig.csms.call("UnlockConnector", payload);
    await settle(rig);
    // one-shot: the second call is answered by the real handler
    await rig.csms.call("UnlockConnector", payload);
    await settle(rig);
  }),
  c16("response-override-remote-start-rejected", async (rig) => {
    rig.cp.armResponseOverride("RemoteStartTransaction", "Rejected");
    await rig.csms.call("RemoteStartTransaction", {
      idTag: "TAG-X",
      connectorId: 1,
    });
    await settle(rig);
  }),
  c201("response-override-alias", async (rig) => {
    // armed under the 1.6 spelling, consumed by the 2.x call
    rig.cp.armResponseOverride("RemoteStartTransaction", "Rejected");
    await rig.csms.call("RequestStartTransaction", {
      idToken: { idToken: "TAG-X", type: "ISO14443" },
      remoteStartId: 2,
      evseId: 1,
    });
    await settle(rig);
  }),
  ...both("unknown-action", async (rig) => {
    await rig.csms.call("NoSuchAction", {});
    await settle(rig);
  }),
  c201("malformed-payload", async (rig) => {
    await rig.csms.call("UnlockConnector", { evseId: "one" });
    await settle(rig);
  }),

  // --- configuration, data transfer, misc -------------------------------
  c16("configuration", async (rig) => {
    await rig.csms.call("GetConfiguration", {});
    await rig.csms.call("GetConfiguration", {
      key: ["HeartbeatInterval", "NoSuchKey"],
    });
    await rig.csms.call("ChangeConfiguration", {
      key: "MeterValueSampleInterval",
      value: "30",
    });
    await rig.csms.call("ChangeConfiguration", {
      key: "NoSuchKey",
      value: "1",
    });
    await settle(rig);
  }),
  c201("variables", async (rig) => {
    await rig.csms.call("GetVariables", {
      getVariableData: [
        {
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "HeartbeatInterval" },
        },
        {
          component: { name: "NoSuchCtrlr" },
          variable: { name: "Nope" },
        },
      ],
    });
    await rig.csms.call("SetVariables", {
      setVariableData: [
        {
          component: { name: "OCPPCommCtrlr" },
          variable: { name: "HeartbeatInterval" },
          attributeValue: "120",
        },
      ],
    });
    await settle(rig);
  }),
  ...both("data-transfer", async (rig) => {
    await rig.csms.call("DataTransfer", { vendorId: "com.example" });
    rig.cp.sendDataTransfer("com.example.cp", "ping", "payload");
    await settle(rig);
  }),
  ...both("clear-cache", async (rig) => {
    await rig.csms.call("ClearCache", {});
    await settle(rig);
  }),
  c16("local-list", async (rig) => {
    await rig.csms.call("GetLocalListVersion", {});
    await rig.csms.call("SendLocalList", {
      listVersion: 1,
      updateType: "Full",
      localAuthorizationList: [
        { idTag: "LOCAL-1", idTagInfo: { status: "Accepted" } },
      ],
    });
    await rig.csms.call("GetLocalListVersion", {});
    await settle(rig);
  }),
  c201("local-list", async (rig) => {
    await rig.csms.call("GetLocalListVersion", {});
    await rig.csms.call("SendLocalList", {
      versionNumber: 1,
      updateType: "Full",
      localAuthorizationList: [
        {
          idToken: { idToken: "LOCAL-1", type: "ISO14443" },
          idTokenInfo: { status: "Accepted" },
        },
      ],
    });
    await rig.csms.call("GetLocalListVersion", {});
    await settle(rig);
  }),
  c16("smart-charging", async (rig) => {
    await charging(rig);
    await rig.csms.call("SetChargingProfile", {
      connectorId: 1,
      csChargingProfiles: {
        chargingProfileId: 1,
        stackLevel: 0,
        chargingProfilePurpose: "TxDefaultProfile",
        chargingProfileKind: "Absolute",
        chargingSchedule: {
          chargingRateUnit: "W",
          chargingSchedulePeriod: [{ startPeriod: 0, limit: 7000 }],
        },
      },
    });
    await rig.csms.call("GetCompositeSchedule", {
      connectorId: 1,
      duration: 600,
    });
    await rig.csms.call("ClearChargingProfile", { id: 1 });
    await settle(rig);
  }),
  c201("smart-charging", async (rig) => {
    await charging(rig);
    await rig.csms.call("SetChargingProfile", {
      evseId: 1,
      chargingProfile: {
        id: 1,
        stackLevel: 0,
        chargingProfilePurpose: "TxDefaultProfile",
        chargingProfileKind: "Absolute",
        chargingSchedule: [
          {
            id: 1,
            chargingRateUnit: "W",
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 7000 }],
          },
        ],
      },
    });
    await rig.csms.call("GetCompositeSchedule", {
      evseId: 1,
      duration: 600,
    });
    await rig.csms.call("ClearChargingProfile", { chargingProfileId: 1 });
    await settle(rig);
  }),

  // --- connection loss ---------------------------------------------------
  ...both("csms-drops-connection", async (rig) => {
    rig.csms.dropConnection();
    await rig.csms.waitForCall("BootNotification", {
      nth: 2,
      timeoutMs: 30_000,
    });
    await settle(rig);
  }),
  ...both("cp-disconnect-connect", async (rig) => {
    rig.cp.disconnect();
    await new Promise((r) => setTimeout(r, 200));
    await rig.connectAndBoot();
  }),
  ...both("transaction-stopped-while-offline", async (rig) => {
    await charging(rig);
    rig.cp.disconnect();
    await new Promise((r) => setTimeout(r, 200));
    rig.cp.stopTransaction(1);
    await new Promise((r) => setTimeout(r, 100));
    await rig.connectAndBoot();
    await settle(rig);
  }),
  ...both("csms-silent-then-reconnect", async (rig) => {
    rig.cp.setInboundCallPolicy("DataTransfer", { kind: "ignore" });
    rig.csms.callNoWait("DataTransfer", { vendorId: "com.example" });
    await settle(rig);
    rig.csms.dropConnection();
    await rig.csms.waitForCall("BootNotification", {
      nth: 2,
      timeoutMs: 30_000,
    });
    await settle(rig);
  }),
];

function rig16or201(p: Record<string, unknown>): Record<string, unknown> {
  const tag = (p.idTag ??
    (p.idToken as { idToken?: string } | undefined)?.idToken) as string;
  const status = tag?.startsWith("CERT023-INV") ? "Invalid" : "Accepted";
  return "idTag" in p ? { idTagInfo: { status } } : { idTokenInfo: { status } };
}
