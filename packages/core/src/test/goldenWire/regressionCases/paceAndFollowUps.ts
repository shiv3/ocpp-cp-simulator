// Regression cases: wire pace timers, firmware and diagnostics, follow-ups across a disconnect.

import { FAR_PAST, statusOf } from "./mutationGaps";
import { SIGNING_CERTIFICATE } from "../../../cp/domain/security/__tests__/signingCertificateFixture";
import type { Rig } from "../rig";
import {
  both,
  c16,
  c201,
  cfg,
  dropAndBack,
  latency,
  charging,
  settle,
  virtual,
  wait,
} from "./helpers";

// Timers that set the pace on the wire: boot retry, heartbeat period, reconnect.
both(
  "boot-retry-pace",
  async (r) => {
    await r.csms.waitForCall("BootNotification", { nth: 2, timeoutMs: 1800 });
    await settle(r);
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
);
// Each version gets its own clock: the cases run concurrently.
for (const add of [c16, c201]) {
  const heartbeatPace = virtual();
  add(
    "heartbeat-pace",
    async (r) => {
      // One period at a time: the next heartbeat is armed once the answer to
      // the last one has arrived, so a single 2.5 s jump would fire only one.
      for (const ms of [1000, 1000, 500]) await heartbeatPace.pause(r, ms);
      await settle(r);
    },
    {
      ...heartbeatPace.options,
      responders: {
        BootNotification: () => ({
          result: {
            status: "Accepted",
            currentTime: "2030-01-01T00:00:00.000Z",
            interval: 1,
          },
        }),
      },
    },
  );
}
both("reconnect-pace", async (r) => {
  r.csms.dropConnection();
  await r.reconnected(2, 6000);
  await settle(r);
});
both("connection-handshake", async (r) => {
  if (
    r.csms.requestPaths.length !== 1 ||
    r.csms.requestPaths[0] !== "/CP-GOLDEN"
  ) {
    throw new Error(
      `unexpected upgrade paths ${JSON.stringify(r.csms.requestPaths)}`,
    );
  }
});

// Firmware: a future retrieve date waits; a failure is one-shot; the in-flight
// flag is released; the steps keep their pace.
c16("firmware-future-retrieve-date", async (r) => {
  await r.csms.call("UpdateFirmware", {
    location: "http://x/fw.bin",
    retrieveDate: new Date(Date.now() + 2500).toISOString(),
  });
  await wait(1000);
  r.cp.sendHeartbeat();
  await wait(5000);
  await settle(r);
});
c16("firmware-step-pace", async (r) => {
  await r.csms.call("UpdateFirmware", {
    location: "http://x/fw.bin",
    retrieveDate: FAR_PAST,
  });
  await wait(1000);
  r.cp.sendHeartbeat();
  await wait(2000);
  r.cp.sendHeartbeat();
  await wait(2000);
  r.cp.sendHeartbeat();
  await wait(4000);
  await settle(r);
});
c16("firmware-failure-is-one-shot", async (r) => {
  cfg(r, "SimulatedFirmwareUpdateFailure", "InstallationFailed");
  const done = (n: number) =>
    r.csms.frames.filter(
      (f) =>
        f.action === "FirmwareStatusNotification" &&
        ["Installed", "InstallationFailed"].includes(statusOf(f) ?? ""),
    ).length >= n;
  const until = async (n: number) => {
    for (let i = 0; i < 300 && !done(n); i++) await wait(100);
  };
  await r.csms.call("UpdateFirmware", {
    location: "http://x/a.bin",
    retrieveDate: FAR_PAST,
  });
  await until(1);
  await settle(r);
  await r.csms.call("UpdateFirmware", {
    location: "http://x/b.bin",
    retrieveDate: FAR_PAST,
  });
  await until(2);
  await settle(r);
  await r.csms.call("UpdateFirmware", {
    location: "http://x/c.bin",
    retrieveDate: FAR_PAST,
  });
  await until(3);
  await settle(r);
});

// Diagnostics: an upload that cannot reach its target reports UploadFailed.
c16("diagnostics-unreachable", async (r) => {
  await r.csms.call("GetDiagnostics", {
    location: "http://127.0.0.1:1/upload",
  });
  await r.csms.waitForCall("DiagnosticsStatusNotification", {
    nth: 2,
    timeoutMs: 20000,
  });
  await settle(r);
});
c16("diagnostics-rejected-by-target", async (r) => {
  await r.csms.call("GetDiagnostics", { location: "ftp://nowhere.invalid/x" });
  await wait(2500);
  await settle(r);
});

// Follow-ups across a disconnect (answers still in the pipe when the socket
// drops): the work continues after the reconnect.
const answeredWhileDropping =
  (action: string, payload: unknown, waitMs: number) => async (r: Rig) => {
    latency(r, 500);
    r.csms.callNoWait(action, payload);
    await wait(100);
    await dropAndBack(r);
    await wait(waitMs);
    await settle(r);
  };
c16(
  "firmware-answered-while-dropping",
  answeredWhileDropping(
    "UpdateFirmware",
    { location: "http://x", retrieveDate: FAR_PAST },
    7000,
  ),
);
c16(
  "signed-firmware-answered-while-dropping",
  answeredWhileDropping(
    "SignedUpdateFirmware",
    {
      requestId: 3,
      firmware: {
        location: "http://x",
        retrieveDateTime: FAR_PAST,
        signingCertificate: SIGNING_CERTIFICATE,
        signature: "s",
      },
    },
    9000,
  ),
);
c16(
  "getlog-answered-while-dropping",
  answeredWhileDropping(
    "GetLog",
    {
      logType: "SecurityLog",
      requestId: 7,
      log: { remoteLocation: "http://x" },
    },
    2500,
  ),
);
c16("firmware-failure-armed-answered-while-dropping", async (r) => {
  cfg(r, "SimulatedFirmwareUpdateFailure", "InstallationFailed");
  await answeredWhileDropping(
    "UpdateFirmware",
    { location: "http://x", retrieveDate: FAR_PAST },
    7000,
  )(r);
});
c201(
  "getlog-answered-while-dropping",
  answeredWhileDropping(
    "GetLog",
    {
      logType: "SecurityLog",
      requestId: 7,
      log: { remoteLocation: "http://x" },
    },
    2500,
  ),
);
c201(
  "firmware-answered-while-dropping",
  answeredWhileDropping(
    "UpdateFirmware",
    {
      requestId: 4,
      firmware: { location: "http://x", retrieveDateTime: FAR_PAST },
    },
    4000,
  ),
);
c16("getlog-then-disconnect-and-second-getlog", async (r) => {
  await r.csms.call("GetLog", {
    logType: "SecurityLog",
    requestId: 7,
    log: { remoteLocation: "http://x" },
  });
  await wait(100);
  await dropAndBack(r);
  await wait(2500);
  await r.csms.call("GetLog", {
    logType: "SecurityLog",
    requestId: 8,
    log: { remoteLocation: "http://x" },
  });
  await wait(2500);
  await settle(r);
});

// Retry after a CALLERROR (1.6) and what the unanswered/refused answers do to the queue.
c16("stop-callerror-retries-then-gives-up", async (r) => {
  cfg(r, "TransactionMessageAttempts", "3");
  cfg(r, "TransactionMessageRetryInterval", "1");
  r.csms.responders.StopTransaction = () => ({
    error: { code: "InternalError", description: "x" },
  });
  await charging(r);
  r.cp.stopTransaction(1);
  await wait(5000);
  await settle(r);
  r.plugIn();
  await settle(r);
});
c16("meter-callerror-no-retry", async (r) => {
  r.csms.responders.MeterValues = () => ({
    error: { code: "InternalError", description: "x" },
  });
  await charging(r);
  r.cp.setMeterValue(1, 100);
  r.cp.sendMeterValue(1);
  await wait(2500);
  await settle(r);
});
// OCPP-J 1.6 errata (2025-04) §2.1 (#745): the Temperature unit stays `Celcius`
// on the 1.6J wire.
c16("meter-temperature-celcius", async (r) => {
  cfg(r, "MeterValuesSampledData", "Energy.Active.Import.Register,Temperature");
  await charging(r);
  r.cp.setMeterValue(1, 100);
  r.cp.sendMeterValue(1);
  await wait(300);
  await settle(r);
});
// E13.FR.03/04 with Part 4 §4.1.1 (#708): Ended waits for the resent Started.
c201("event-resend-holds-ended", async (r) => {
  cfg(r, "TransactionMessageAttempts", "3");
  cfg(r, "TransactionMessageRetryInterval", "1");
  r.csms.responders.TransactionEvent = (_p, c) =>
    c.nth < 2 ? { error: { code: "InternalError", description: "x" } } : {};
  r.plugIn();
  await settle(r);
  await r.cp.startTransaction("TAG-E", 1);
  await wait(200);
  r.cp.stopTransaction(1);
  await wait(3000);
  await settle(r);
});
c201("event-callerror-retries", async (r) => {
  cfg(r, "TransactionMessageAttempts", "3");
  cfg(r, "TransactionMessageRetryInterval", "1");
  r.csms.responders.TransactionEvent = (_p, c) =>
    c.nth < 3 ? { error: { code: "InternalError", description: "x" } } : {};
  r.plugIn();
  await settle(r);
  await r.cp.startTransaction("TAG-E", 1);
  await wait(4000);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
});

// #565, E13.FR.04: the Ended event built during the Started event's retry
// waits for the resend.
c201("event-callerror-stop-during-retry", async (r) => {
  cfg(r, "TransactionMessageAttempts", "3");
  cfg(r, "TransactionMessageRetryInterval", "1");
  r.csms.responders.TransactionEvent = (_p, c) =>
    c.nth < 2 ? { error: { code: "InternalError", description: "x" } } : {};
  r.plugIn();
  await settle(r);
  await r.cp.startTransaction("TAG-E", 1);
  await wait(200);
  r.cp.stopTransaction(1);
  await wait(2500);
  await settle(r);
});

// Connection close with work in flight on the other side.
both("close-during-remote-start-follow-up", async (r) => {
  r.plugIn();
  await settle(r);
  latency(r, 400);
  void (r.is16
    ? r.csms.callNoWait("RemoteStartTransaction", {
        idTag: "TAG-C",
        connectorId: 1,
      })
    : r.csms.callNoWait("RequestStartTransaction", {
        idToken: { idToken: "TAG-C", type: "ISO14443" },
        remoteStartId: 5,
        evseId: 1,
      }));
  await wait(100);
  await dropAndBack(r);
  await wait(1500);
  await settle(r);
});
both("close-during-reset", async (r) => {
  latency(r, 400);
  r.csms.callNoWait("Reset", r.is16 ? { type: "Soft" } : { type: "Immediate" });
  await wait(100);
  await dropAndBack(r);
  await wait(1500);
  await settle(r);
});
