// Regression cases: gaps found by mutation testing of the first golden set.

import type { Rig } from "../rig";
import type { GoldenCase as Case } from "../cases";
import {
  authorizeRemote,
  both,
  c16,
  c201,
  cases,
  charging,
  settle,
  two,
  virtual,
} from "./helpers";

// --- gaps found by mutation testing of the first golden set ---------------
const strict = (
  name: string,
  version: "1.6" | "2.0.1",
  run: Case["run"],
  options?: Case["options"],
) =>
  cases.push({
    name: `${version === "1.6" ? "16" : "201"}-${name}`,
    version,
    run,
    options,
    strict: true,
  });
export const FAR_PAST = "2020-01-01T00:00:00.000Z";
const stationAvail = (r: Rig, type: "Operative" | "Inoperative") =>
  r.is16
    ? r.csms.call("ChangeAvailability", { connectorId: 0, type })
    : r.csms.call("ChangeAvailability", { operationalStatus: type });
export const statusOf = (f: { payload: unknown }) =>
  (f.payload as { status?: string }).status;

// A StopTransaction / TransactionEvent(Ended) carries the stop time, and every
// timestamp keeps its millisecond form (strict normalization).
for (const v of ["1.6", "2.0.1"] as const) {
  const ts = virtual();
  strict(
    "timestamps-start-meter-stop",
    v,
    async (r) => {
      r.plugIn();
      await settle(r);
      await r.cp.startTransaction("TAG-T", 1);
      await settle(r);
      await ts.pause(r, 2000);
      r.cp.setMeterValue(1, 500);
      r.cp.sendMeterValue(1);
      await settle(r);
      await ts.pause(r, 2000);
      r.cp.stopTransaction(1);
      await settle(r);
    },
    ts.options,
  );
}
strict(
  "message-ids-are-uuids",
  "1.6",
  async (r) => {
    await charging(r);
    r.cp.stopTransaction(1);
    await settle(r);
  },
  virtual().options,
);

// The offline queue is flushed in order, with the original timestamps.
const flush16 = virtual();
strict(
  "offline-flush-order",
  "1.6",
  async (r) => {
    await charging(r);
    r.cp.disconnect();
    await flush16.pause(r, 200);
    for (const wh of [100, 200, 300]) {
      r.cp.setMeterValue(1, wh);
      r.cp.sendMeterValue(1);
      await flush16.pause(r, 1100);
    }
    r.cp.stopTransaction(1);
    await flush16.pause(r, 100);
    await r.connectAndBoot();
    await settle(r);
  },
  flush16.options,
);
const flush201 = virtual();
strict(
  "offline-flush-order",
  "2.0.1",
  async (r) => {
    await charging(r);
    r.cp.disconnect();
    await flush201.pause(r, 200);
    for (const wh of [100, 200, 300]) {
      r.cp.setMeterValue(1, wh);
      r.cp.sendMeterValue(1);
      await flush201.pause(r, 1100);
    }
    r.cp.stopTransaction(1);
    await flush201.pause(r, 100);
    await r.connectAndBoot();
    await settle(r);
  },
  flush201.options,
);

// AuthorizeRemoteTxRequests: the Authorize goes first, and a denial stops it.
both(
  "remote-start-authorize-denied",
  async (r) => {
    authorizeRemote(r, true);
    r.plugIn();
    await settle(r);
    await r.remoteStart("CERT023-INV");
    await settle(r);
  },
  {
    responders: {
      Authorize: (p) =>
        "idTag" in p
          ? { idTagInfo: { status: "Invalid" } }
          : { idTokenInfo: { status: "Invalid" } },
    },
  },
);
// F01.FR.01/02: a Blocked answer keeps the 2.x start from happening (the
// RequestStartTransaction answer is Accepted first); Central and
// NoAuthorization tokens are never sent to Authorize.
c201(
  "remote-start-authorize-blocked",
  async (r) => {
    authorizeRemote(r, true);
    r.plugIn();
    await settle(r);
    await r.remoteStart("TAG-BLOCKED");
    await settle(r);
  },
  {
    responders: { Authorize: () => ({ idTokenInfo: { status: "Blocked" } }) },
  },
);
c201("remote-start-authorize-central-token", async (r) => {
  authorizeRemote(r, true);
  r.plugIn();
  await settle(r);
  await r.csms.call("RequestStartTransaction", {
    idToken: { idToken: "CENTRAL-1", type: "Central" },
    remoteStartId: 1,
    evseId: 1,
  });
  await settle(r);
  await r.remoteStop();
});
both("remote-start-no-authorize", async (r) => {
  authorizeRemote(r, false);
  r.plugIn();
  await settle(r);
  await r.remoteStart("TAG-NA");
  await settle(r);
  await r.remoteStop();
});
// #921: the key is the station's choice to make writable (1.6 §9.1.3, 2.0.1
// Part 2 §2.3.4: R or RW); the CSMS turns it on, and the remote start then
// authorizes first.
c16("remote-start-authorize-change-configuration", async (r) => {
  await r.csms.call("ChangeConfiguration", {
    key: "AuthorizeRemoteTxRequests",
    value: "true",
  });
  r.plugIn();
  await settle(r);
  await r.remoteStart("TAG-RA");
  await settle(r);
  await r.remoteStop();
});
c201("remote-start-authorize-set-variables", async (r) => {
  await r.csms.call("SetVariables", {
    setVariableData: [
      {
        component: { name: "AuthCtrlr" },
        variable: { name: "AuthorizeRemoteStart" },
        attributeValue: "true",
      },
    ],
  });
  r.plugIn();
  await settle(r);
  await r.remoteStart("TAG-RA");
  await settle(r);
  await r.remoteStop();
});

// Whole-station ChangeAvailability while a transaction runs.
both(
  "avail-station-during-tx",
  async (r) => {
    await charging(r, "A", 1);
    await stationAvail(r, "Inoperative");
    await settle(r);
    r.cp.stopTransaction(1);
    await settle(r);
    r.unplug(1);
    await settle(r);
    await stationAvail(r, "Operative");
    await settle(r);
  },
  two,
);
both(
  "avail-station-idle-two",
  async (r) => {
    await stationAvail(r, "Inoperative");
    await settle(r);
    await r.remoteStart("X", 2);
    await stationAvail(r, "Operative");
    await settle(r);
  },
  two,
);

// A TxProfile lives as long as its transaction; a TxDefaultProfile does not.
c16("txprofile-cleared-at-end", async (r) => {
  await charging(r);
  const profile = (id: number, purpose: string) => ({
    connectorId: 1,
    csChargingProfiles: {
      chargingProfileId: id,
      stackLevel: id,
      chargingProfilePurpose: purpose,
      chargingProfileKind: "Absolute",
      chargingSchedule: {
        chargingRateUnit: "W",
        chargingSchedulePeriod: [{ startPeriod: 0, limit: 1000 * id }],
      },
    },
  });
  await r.csms.call("SetChargingProfile", profile(1, "TxProfile"));
  await r.csms.call("SetChargingProfile", profile(2, "TxDefaultProfile"));
  await r.csms.call("GetCompositeSchedule", { connectorId: 1, duration: 600 });
  r.cp.stopTransaction(1);
  await settle(r);
  await r.csms.call("GetCompositeSchedule", { connectorId: 1, duration: 600 });
  await r.csms.call("ClearChargingProfile", { id: 1 });
  await r.csms.call("ClearChargingProfile", { id: 2 });
  await settle(r);
});
c201("txprofile-cleared-at-end", async (r) => {
  await charging(r);
  const profile = (id: number, purpose: string) => ({
    evseId: 1,
    chargingProfile: {
      id,
      stackLevel: id,
      chargingProfilePurpose: purpose,
      chargingProfileKind: "Absolute",
      ...(purpose === "TxProfile" ? { transactionId: r.transactionId(1) } : {}),
      chargingSchedule: [
        {
          id,
          chargingRateUnit: "W",
          chargingSchedulePeriod: [{ startPeriod: 0, limit: 1000 * id }],
        },
      ],
    },
  });
  await r.csms.call("SetChargingProfile", profile(1, "TxProfile"));
  await r.csms.call("SetChargingProfile", profile(2, "TxDefaultProfile"));
  await r.csms.call("GetCompositeSchedule", { evseId: 1, duration: 600 });
  r.cp.stopTransaction(1);
  await settle(r);
  await r.csms.call("GetCompositeSchedule", { evseId: 1, duration: 600 });
  await r.csms.call("ClearChargingProfile", { chargingProfileId: 1 });
  await r.csms.call("ClearChargingProfile", { chargingProfileId: 2 });
  await settle(r);
});

// Inbound policy beats a response override on the same action (and a policy
// set later still wins), in both directions of arming.
both("policy-and-override-same-action", async (r) => {
  const payload = r.is16 ? { connectorId: 1 } : { evseId: 1, connectorId: 1 };
  r.cp.armResponseOverride("UnlockConnector", "Failed");
  r.cp.setInboundCallPolicy("UnlockConnector", {
    kind: "callerror",
    errorCode: "NotSupported",
    errorDescription: "policy",
  });
  await r.csms.call("UnlockConnector", payload);
  await settle(r);
  r.cp.clearInboundCallPolicy("UnlockConnector");
  await r.csms.call("UnlockConnector", payload);
  await settle(r);
  await r.csms.call("UnlockConnector", payload);
  await settle(r);
});
both("policy-ignore-and-override", async (r) => {
  r.cp.armResponseOverride("TriggerMessage", "Rejected");
  r.cp.setInboundCallPolicy("TriggerMessage", { kind: "ignore" });
  r.csms.callNoWait("TriggerMessage", { requestedMessage: "Heartbeat" });
  await settle(r);
  r.cp.clearInboundCallPolicy("TriggerMessage");
  await r.csms.call("TriggerMessage", { requestedMessage: "Heartbeat" });
  await settle(r);
});
