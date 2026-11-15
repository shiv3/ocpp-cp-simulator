// Regression cases: drops and latency with follow-ups in flight (round 2).
/* eslint-disable @typescript-eslint/no-explicit-any --
   these cases reach into station internals (configuration, listeners, runtime
   snapshots) that the public types do not expose */
import { SIGNING_CERTIFICATE } from "../../../cp/domain/security/__tests__/signingCertificateFixture";
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type { Rig } from "../rig";
import {
  both,
  c16,
  c201,
  cfg,
  charging,
  dropAndBack,
  FUT,
  latency,
  settle,
  two,
  wait,
} from "./helpers";

// --- round 2
c16("ns-firmware-drop", async (r) => {
  latency(r);
  r.csms.callNoWait("UpdateFirmware", {
    location: "http://x",
    retrieveDate: "2020-01-01T00:00:00.000Z",
  });
  await wait(100);
  await dropAndBack(r);
  await wait(9000);
  await settle(r);
});
c16("ns-signed-firmware-drop", async (r) => {
  latency(r);
  r.csms.callNoWait("SignedUpdateFirmware", {
    requestId: 3,
    firmware: {
      location: "http://x",
      retrieveDateTime: "2020-01-01T00:00:00.000Z",
      signingCertificate: SIGNING_CERTIFICATE,
      signature: "s",
    },
  });
  await wait(100);
  await dropAndBack(r);
  await wait(11000);
  await settle(r);
});
c16("ns-getlog-drop", async (r) => {
  latency(r);
  r.csms.callNoWait("GetLog", {
    logType: "SecurityLog",
    requestId: 7,
    log: { remoteLocation: "http://x" },
  });
  await wait(100);
  await dropAndBack(r);
  await wait(3000);
  await settle(r);
});
c16("ns-diagnostics-drop", async (r) => {
  latency(r);
  r.csms.callNoWait("GetDiagnostics", { location: r.uploadUrl() });
  await wait(100);
  await dropAndBack(r);
  await wait(1000);
  await settle(r);
});
// #867: a drop that lands while the station's answer to a CSMS CALL is held by
// a latency rule. The answer is held by a rule far longer than the case, the
// drop follows the moment the station holds it (a condition, not a 100 ms
// window), and the 500 ms rule is back before the station reconnects, so what
// follows is paced as before. The case ends on a quiet window longer than the
// rule instead of a fixed wait.
const HELD_MS = 60_000;
const upstreamHeld = (r: Rig): number =>
  (r.cp as any)._webSocket._controller.upstreamPipeline.size;
const dropWithAnswerHeld = async (r: Rig, send: () => void) => {
  latency(r, HELD_MS);
  send();
  await r.until(() => upstreamHeld(r) > 0, "the station's answer to be held");
  r.csms.dropConnection();
  latency(r);
  await r.reconnected(2);
  // 2.x sends one CALL at a time (#708): each is 500 ms behind the last.
  await r.csms.settle(1500);
};
// `charging` plus the wait for the StatusNotification the last step causes,
// which settle() does not see coming.
const chargingSynced = async (r: Rig, tag = "TAG-1", c = 1) => {
  r.plugIn(c);
  await settle(r);
  await r.cp.startTransaction(tag, c);
  await settle(r);
  const from = r.csms.mark();
  r.cp.updateConnectorStatus(c, OCPPStatus.Charging);
  await r.csms.waitForFrame(
    (f) => f.dir === "CP>" && f.action === "StatusNotification",
    { from },
  );
  await settle(r);
};
both("ns-remote-stop-drop", async (r) => {
  await chargingSynced(r);
  const id = r.transactionId(1);
  await dropWithAnswerHeld(r, () => {
    void (r.is16
      ? r.csms.callNoWait("RemoteStopTransaction", { transactionId: id })
      : r.csms.callNoWait("RequestStopTransaction", { transactionId: id }));
  });
});
both("ns-remote-start-drop", async (r) => {
  await dropWithAnswerHeld(r, () => {
    void (r.is16
      ? r.csms.callNoWait("RemoteStartTransaction", {
          idTag: "T",
          connectorId: 1,
        })
      : r.csms.callNoWait("RequestStartTransaction", {
          idToken: { idToken: "T", type: "ISO14443" },
          remoteStartId: 4,
          evseId: 1,
        }));
  });
});
both("ns-reset-drop", async (r) => {
  await chargingSynced(r);
  await dropWithAnswerHeld(r, () => {
    r.csms.callNoWait("Reset", { type: r.is16 ? "Soft" : "Immediate" });
  });
});
both("ns-avail-drop", async (r) => {
  latency(r);
  void (r.is16
    ? r.csms.callNoWait("ChangeAvailability", {
        connectorId: 1,
        type: "Inoperative",
      })
    : r.csms.callNoWait("ChangeAvailability", {
        operationalStatus: "Inoperative",
        evse: { id: 1 },
      }));
  await wait(100);
  await dropAndBack(r);
  await wait(1000);
  await settle(r);
});
both("ns-reserve-drop", async (r) => {
  latency(r);
  void (r.is16
    ? r.csms.callNoWait("ReserveNow", {
        connectorId: 1,
        expiryDate: FUT,
        idTag: "O",
        reservationId: 3,
      })
    : r.csms.callNoWait("ReserveNow", {
        id: 3,
        evseId: 1,
        expiryDateTime: FUT,
        idToken: { idToken: "O", type: "ISO14443" },
      }));
  await wait(100);
  await dropAndBack(r);
  await wait(1000);
  await settle(r);
});
// OCPP-J 2.0.1 §5.4, B04.FR.01/02 (#702): a reconnect sends no BootNotification
// while the boot data is unchanged; the connectors are reported only when the
// outage exceeded OfflineThreshold (here 0 s: any outage does).
c201(
  "reconnect-exceeds-offline-threshold",
  async (r) => {
    cfg(r, "OfflineThreshold", "0");
    r.csms.dropConnection();
    await r.reconnected();
    await settle(r);
  },
  two,
);
// The simulator option BootOnReconnect keeps a BootNotification on every connect.
c201("reconnect-boot-on-reconnect", async (r) => {
  cfg(r, "BootOnReconnect", "true");
  r.csms.dropConnection();
  await r.reconnected();
  await settle(r);
});
// Changed boot data is a reason to boot again (§5.4).
c201("reconnect-boot-data-changed", async (r) => {
  (r.cp as any)._bootNotification = {
    ...(r.cp as any)._bootNotification,
    firmwareVersion: "2.0",
  };
  r.csms.dropConnection();
  await r.reconnected();
  await settle(r);
});
both("ns-remote-start-order", async (r) => {
  latency(r, 200);
  await r.remoteStart("A");
  await wait(1200);
  await settle(r);
  await r.remoteStop();
  await wait(1000);
  await settle(r);
});
c16("ns-reset-hard-order", async (r) => {
  await charging(r);
  latency(r, 200);
  await r.csms.call("Reset", { type: "Hard" });
  await r.csms.waitForCall("BootNotification", { nth: 2, timeoutMs: 30000 });
  await wait(1000);
  await settle(r);
});
