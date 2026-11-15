// Regression cases: TriggerMessage, firmware, log and diagnostics.
import { SIGNING_CERTIFICATE } from "../../../cp/domain/security/__tests__/signingCertificateFixture";
import { c16, c201, charging, settle, wait } from "./helpers";

// #596: TriggerMessage for TransactionEvent, FirmwareStatusNotification and
// LogStatusNotification on 2.x.
c201("trigger-transaction-event", async (r) => {
  await r.csms.call("TriggerMessage", { requestedMessage: "TransactionEvent" });
  await settle(r);
  await charging(r);
  await r.csms.call("TriggerMessage", {
    requestedMessage: "TransactionEvent",
    evse: { id: 1 },
  });
  await r.csms.call("TriggerMessage", {
    requestedMessage: "TransactionEvent",
    evse: { id: 2 },
  });
  await settle(r);
});
// Nothing was requested: both triggered reports are Idle, without a requestId
// (F06.FR.16 firmware, F06.FR.15 log).
c201("trigger-status-idle-without-requests", async (r) => {
  await r.csms.call("TriggerMessage", {
    requestedMessage: "FirmwareStatusNotification",
  });
  await r.csms.call("TriggerMessage", {
    requestedMessage: "LogStatusNotification",
  });
  await settle(r);
});
// After an accepted GetLog the station's own upload (#601) is running, so the
// triggered log report is Uploading with requestId 12 (F06.FR.14). The
// firmware report stays Idle in this flow (the UpdateFirmware is not
// reported as in progress; F06.FR.16 covers the not-updating case above).
c201("trigger-status-log-uploading-after-getlog", async (r) => {
  await r.csms.call("UpdateFirmware", {
    requestId: 11,
    firmware: {
      location: "http://x",
      retrieveDateTime: "2020-01-01T00:00:00.000Z",
    },
  });
  await r.csms.call("GetLog", {
    requestId: 12,
    logType: "DiagnosticsLog",
    log: { remoteLocation: "http://x" },
  });
  await r.csms.call("TriggerMessage", {
    requestedMessage: "FirmwareStatusNotification",
  });
  await r.csms.call("TriggerMessage", {
    requestedMessage: "LogStatusNotification",
  });
  await settle(r);
});
c16("firmware-trigger-status", async (r) => {
  await r.csms.call("TriggerMessage", {
    requestedMessage: "FirmwareStatusNotification",
  });
  await settle(r);
  await r.csms.call("UpdateFirmware", {
    location: "http://x",
    retrieveDate: "2020-01-01T00:00:00.000Z",
  });
  await wait(2500);
  await r.csms.call("TriggerMessage", {
    requestedMessage: "FirmwareStatusNotification",
  });
  await wait(6000);
  await r.csms.call("TriggerMessage", {
    requestedMessage: "FirmwareStatusNotification",
  });
  await r.csms.call("TriggerMessage", {
    requestedMessage: "DiagnosticsStatusNotification",
  });
  await settle(r);
});
c16("firmware-soft-reset-midway", async (r) => {
  await r.csms.call("UpdateFirmware", {
    location: "http://x",
    retrieveDate: "2020-01-01T00:00:00.000Z",
  });
  await wait(300);
  await r.csms.call("Reset", { type: "Soft" });
  await wait(7000);
  await settle(r);
});
c16("firmware-hard-reset-midway", async (r) => {
  await r.csms.call("UpdateFirmware", {
    location: "http://x",
    retrieveDate: "2020-01-01T00:00:00.000Z",
  });
  await wait(300);
  await r.csms.call("Reset", { type: "Hard" });
  await r.csms.waitForCall("BootNotification", { nth: 2, timeoutMs: 30000 });
  await wait(7000);
  await settle(r);
});
c16("firmware-invalid-date", async (r) => {
  await r.csms.call("UpdateFirmware", {
    location: "http://x",
    retrieveDate: "nope",
  });
  await wait(100);
  await r.csms.call("SignedUpdateFirmware", {
    requestId: 3,
    firmware: {
      location: "http://x",
      retrieveDateTime: "nope",
      signingCertificate: SIGNING_CERTIFICATE,
      signature: "s",
    },
  });
  await wait(9000);
  await settle(r);
});
c16("firmware-missing-date", async (r) => {
  await r.csms.call("UpdateFirmware", { location: "http://x" });
  await wait(3000);
  await settle(r);
});
c16("signed-firmware-missing-firmware", async (r) => {
  await r.csms
    .call("SignedUpdateFirmware", { requestId: 3 })
    .catch(() => undefined);
  await settle(r);
});
c16("getlog-garbage", async (r) => {
  await r.csms.call("GetLog", {}).catch(() => undefined);
  await wait(2500);
  await settle(r);
});
c16("diagnostics-bad-url", async (r) => {
  await r.csms
    .call("GetDiagnostics", { location: "ftp://nope/x" })
    .catch(() => undefined);
  await r.csms.call("GetDiagnostics", {}).catch(() => undefined);
  await wait(500);
  await settle(r);
});
