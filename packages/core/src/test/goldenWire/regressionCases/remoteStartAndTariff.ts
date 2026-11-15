// Regression cases: reservations, remote start variants, customer information, tariffs.

import {
  both,
  c16,
  c201,
  c21,
  cfg,
  changeAvail,
  charging,
  FUT,
  reserve,
  settle,
  wait,
} from "./helpers";

// A reservation is consumed by the transaction that uses it; it expires on its
// own and frees the connector.
c16("reservation-consumed", async (r) => {
  await reserve(r, 41, 1, "OWNER", FUT);
  await settle(r);
  r.plugIn();
  await settle(r);
  await r.cp.startTransaction("OWNER", 1);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
  r.unplug();
  await settle(r);
  r.plugIn();
  await settle(r);
  await r.cp.startTransaction("OTHER", 1);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
  await r.csms.call("CancelReservation", { reservationId: 41 });
  await settle(r);
});
c201("reservation-consumed", async (r) => {
  await reserve(r, 41, 1, "OWNER", FUT);
  await settle(r);
  r.plugIn();
  await settle(r);
  await r.cp.startTransaction("OWNER", 1);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
  r.unplug();
  await settle(r);
  await r.csms.call("CancelReservation", { reservationId: 41 });
  await settle(r);
  await r.remoteStart("OTHER", 1);
  await r.remoteStop();
});
both("reservation-expires-by-itself", async (r) => {
  await reserve(r, 42, 1, "OWNER", new Date(Date.now() + 1500).toISOString());
  await settle(r);
  await wait(2500);
  await settle(r);
  await r.remoteStart("OTHER", 1);
  await r.remoteStop();
});
c201("reserve-occupied", async (r) => {
  await charging(r);
  await reserve(r, 43, 1, "OWNER", FUT);
  await settle(r);
});

// ConnectionTimeOut: a plugged-in connector with no start goes back to Available.
both("connection-timeout-returns-to-available", async (r) => {
  cfg(r, "ConnectionTimeOut", "1");
  r.plugIn();
  await wait(2500);
  await settle(r);
});

// Remote start on an inoperative connector, 2.x reset with an unknown EVSE.
both("remote-start-inoperative", async (r) => {
  await changeAvail(r, "Inoperative", 1);
  await settle(r);
  r.plugIn();
  await settle(r);
  await r.remoteStart("X", 1);
  await settle(r);
});
// #599: the TransactionEvent carries the idToken (type included) of the
// RequestStartTransaction, F01.FR.04.
c201("remote-start-central-type", async (r) => {
  await r.csms.call("RequestStartTransaction", {
    remoteStartId: 1,
    idToken: { idToken: "TAG-A", type: "Central" },
  });
  await settle(r);
});
// #598: RequestStartTransaction validation and the reason codes of a rejection.
c201("remote-start-invalid-profile", async (r) => {
  const schedule = [
    {
      id: 1,
      chargingRateUnit: "W",
      chargingSchedulePeriod: [{ startPeriod: 0, limit: 7000 }],
    },
  ];
  const profile = {
    id: 1,
    stackLevel: 0,
    chargingProfileKind: "Absolute",
    chargingSchedule: schedule,
  };
  const idToken = { idToken: "TAG-A", type: "Central" };
  await r.csms.call("RequestStartTransaction", {
    remoteStartId: 1,
    idToken,
    chargingProfile: { ...profile, chargingProfilePurpose: "TxDefaultProfile" },
  });
  await r.csms.call("RequestStartTransaction", {
    remoteStartId: 2,
    idToken,
    chargingProfile: {
      ...profile,
      chargingProfilePurpose: "TxProfile",
      transactionId: "tx-1",
    },
  });
  await settle(r);
});
c201("remote-start-master-pass", async (r) => {
  r.cp.configuration.setRuntimeValue("MasterPassGroupId", "MASTER");
  await r.csms.call("RequestStartTransaction", {
    remoteStartId: 1,
    idToken: { idToken: "TAG-A", type: "Central" },
    groupIdToken: { idToken: "MASTER", type: "Central" },
  });
  await settle(r);
});
c201("remote-start-unknown-evse", async (r) => {
  await r.csms.call("RequestStartTransaction", {
    remoteStartId: 1,
    idToken: { idToken: "TAG-A", type: "Central" },
    evseId: 9,
  });
  await settle(r);
});
c201("remote-start-any-evse", async (r) => {
  // The case is about EVSE selection, so the type is fixed and the recorded
  // wire does not depend on how the started event reports a request type.
  const idToken = { idToken: "TAG-A", type: "ISO14443" };
  await r.csms.call("RequestStartTransaction", { remoteStartId: 1, idToken });
  await settle(r);
  await r.csms.call("RequestStartTransaction", { remoteStartId: 2, idToken });
  await settle(r);
});
// #602: CustomerInformation answers and reports through
// NotifyCustomerInformation.
c201("customer-information", async (r) => {
  r.cp.authorization.seedCache([{ idToken: "TAG-C", status: "Accepted" }]);
  const idToken = { idToken: "TAG-C", type: "Central" };
  await r.csms.call("CustomerInformation", {
    requestId: 1,
    report: true,
    clear: false,
    idToken,
  });
  await r.csms.call("CustomerInformation", {
    requestId: 2,
    report: true,
    clear: true,
    idToken,
  });
  await r.csms.call("CustomerInformation", {
    requestId: 3,
    report: false,
    clear: false,
    idToken,
  });
  await r.csms.call("CustomerInformation", {
    requestId: 4,
    report: true,
    clear: false,
  });
  await settle(r);
});
c201("reset-unknown-evse", async (r) => {
  await r.csms.call("Reset", { type: "Immediate", evseId: 9 });
  await settle(r);
});
c201("reset-immediate-resume-charging", async (r) => {
  await charging(r);
  await r.csms.call("Reset", { type: "ImmediateAndResume", evseId: 1 });
  await settle(r);
});

// 2.1 I07.FR.01 / I11.FR.01: without local cost calculation SetDefaultTariff
// and ChangeTransactionTariff are an RPC CALLERROR NotSupported, not a status;
// GetTariffs / ClearTariffs (I09.FR.03, I10.FR.06) stay NoTariff results.
c21("tariff-without-local-cost-calculation", async (r) => {
  await charging(r);
  const tariff = { tariffId: "T-1", currency: "EUR" };
  await r.csms.call("SetDefaultTariff", { evseId: 1, tariff });
  await r.csms.call("ChangeTransactionTariff", {
    tariff,
    transactionId: r.transactionId(1),
  });
  await r.csms.call("GetTariffs", { evseId: 1 });
  await r.csms.call("ClearTariffs", {});
  await settle(r);
});
// 2.1 B13.FR.01 / B13.FR.02: no transaction resumption, so ImmediateAndResume
// is Rejected while a transaction runs and the transaction keeps running; with
// none it is an Immediate reset.
c21("reset-immediate-resume-charging", async (r) => {
  await charging(r);
  await r.csms.call("Reset", { type: "ImmediateAndResume", evseId: 1 });
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
});
c21("reset-immediate-resume-idle", async (r) => {
  await r.csms.call("Reset", { type: "ImmediateAndResume" });
  await wait(600);
  await settle(r);
});
// 2.1 K21.FR.01 / FR.02 / FR.06: UsePriorityCharging looks the transaction up;
// the station never has a PriorityCharging profile.
c21("use-priority-charging", async (r) => {
  await charging(r);
  const transactionId = r.transactionId(1);
  await r.csms.call("UsePriorityCharging", { transactionId, activate: true });
  await r.csms.call("UsePriorityCharging", { transactionId, activate: false });
  await r.csms.call("UsePriorityCharging", {
    transactionId: "no-such-transaction",
    activate: true,
  });
  await settle(r);
});
