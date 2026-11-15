// Regression cases: malformed calls, local list, listeners, transaction updates.
/* eslint-disable @typescript-eslint/no-explicit-any --
   these cases reach into station internals (configuration, listeners, runtime
   snapshots) that the public types do not expose */
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import type { Rig } from "../rig";
import type { GoldenCase as Case } from "../cases";
import {
  both,
  c16,
  c201,
  changeAvail,
  charging,
  restart,
  settle,
  virtual,
  wait,
} from "./helpers";

const malformedc201V = virtual();
c201(
  "malformed-calls",
  async (r) => {
    for (const [a, p] of [
      ["RequestStartTransaction", {}],
      ["RequestStartTransaction", { remoteStartId: 1, idToken: {} }],
      ["RequestStopTransaction", {}],
      ["Reset", {}],
      ["ChangeAvailability", {}],
      ["UnlockConnector", {}],
      ["ReserveNow", {}],
      ["CancelReservation", {}],
      ["GetLog", {}],
      ["UpdateFirmware", {}],
    ] as const) {
      await r.csms.call(a, p, 3000).catch(() => undefined);
      await malformedc201V.pause(r, 30);
    }
    await settle(r);
  },
  malformedc201V.options,
);
// 1.6 §3.5.2 (#744): a CSMS verdict that contradicts the Local Authorization
// List is reported with StatusNotification(0, LocalListConflict).
const sendLocalList16 = (r: Rig, status = "Accepted") =>
  r.csms.call("SendLocalList", {
    listVersion: 1,
    updateType: "Full",
    localAuthorizationList: [{ idTag: "LOCAL-1", idTagInfo: { status } }],
  });
c16(
  "local-list-conflict-authorize",
  async (r) => {
    await sendLocalList16(r);
    r.cp.authorize("LOCAL-1");
    await wait(300);
    await settle(r);
  },
  {
    responders: {
      Authorize: () => ({ idTagInfo: { status: "Blocked" } }),
    },
  },
);
c16(
  "local-list-conflict-start",
  async (r) => {
    await sendLocalList16(r);
    r.plugIn();
    await settle(r);
    await r.cp.startTransaction("LOCAL-1", 1);
    await wait(300);
    await settle(r);
  },
  {
    responders: {
      StartTransaction: () => ({
        transactionId: 7,
        idTagInfo: { status: "Blocked" },
      }),
    },
  },
);
c16("local-list-no-conflict", async (r) => {
  await sendLocalList16(r);
  r.cp.authorize("LOCAL-1");
  r.cp.authorize("OTHER-1");
  await wait(300);
  await settle(r);
});
// OCPP-J 2.0.1 / 2.1 Part 4 §4.3 Table 8 (#715): one CALLERROR per kind of
// violation that malformed-calls (missing properties) does not show.
c201("violation-codes", async (r) => {
  for (const [a, p] of [
    ["ChangeAvailability", { operationalStatus: 5 }],
    ["ChangeAvailability", { operationalStatus: "Nope" }],
    ["UnlockConnector", { evseId: 1, connectorId: 1, extra: true }],
    ["ClearCache", "nope"],
    ["SetVariables", { setVariableData: [] }],
  ] as const) {
    await r.csms.call(a, p, 3000).catch(() => undefined);
    await wait(30);
  }
  await settle(r);
});
const malformedc16V = virtual();
c16(
  "malformed-calls",
  async (r) => {
    for (const [a, p] of [
      ["RemoteStartTransaction", {}],
      ["RemoteStopTransaction", {}],
      ["Reset", {}],
      ["ChangeAvailability", {}],
      ["UnlockConnector", {}],
      ["ReserveNow", {}],
      ["CancelReservation", {}],
      ["GetLog", {}],
      ["UpdateFirmware", {}],
      ["GetDiagnostics", {}],
      ["SignedUpdateFirmware", {}],
    ] as const) {
      await r.csms.call(a, p, 3000).catch(() => undefined);
      await malformedc16V.pause(r, 30);
    }
    await settle(r);
  },
  malformedc16V.options,
);
both("preparing-listener-stops", async (r) => {
  let done = false;
  r.plugIn();
  await settle(r);
  r.cp.updateConnectorStatus(1, OCPPStatus.Available);
  await settle(r);
  r.cp.events.on("connectorStatusChange", (e: any) => {
    if (e.status === OCPPStatus.Preparing && !done) {
      done = true;
      r.cp.stopTransaction(1, "Other");
    }
  });
  await r.cp.startTransaction("N", 1);
  await settle(r);
  await r.cp.startTransaction("M", 1);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
});
both("finishing-listener-starts", async (r) => {
  let done = false;
  r.cp.events.on("connectorStatusChange", (e: any) => {
    if (e.status === OCPPStatus.Finishing && !done) {
      done = true;
      void r.cp.startTransaction("NEXT", 1);
    }
  });
  await charging(r);
  r.cp.stopTransaction(1);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
});
both("meter-then-stop", async (r) => {
  await charging(r);
  const c = r.cp.getConnector(1)!;
  c.meterValue = 1234;
  await settle(r);
  r.cp.stopTransaction(1, "Local");
  await settle(r);
});
c201("transaction-update-driven", async (r) => {
  await charging(r);
  (r.cp as any).sendTransactionUpdate?.(1, {
    triggerReason: "MeterValuePeriodic",
    meterValues: true,
    chargingState: "SuspendedEV",
  });
  await settle(r);
  r.cp.updateConnectorStatus(1, OCPPStatus.SuspendedEV);
  await settle(r);
  r.cp.updateConnectorStatus(1, OCPPStatus.Charging);
  await settle(r);
  r.cp.stopTransaction(1, "EVDisconnected", {
    triggerReason: "EVCommunicationLost",
    stoppedReason: "SOCLimitReached",
  } as any);
  await settle(r);
});

const withNext = (
  name: string,
  run: (r: Rig, n: Rig) => Promise<void>,
  pre: (r: Rig) => Promise<void>,
  opts?: Case["options"],
) =>
  both(
    name,
    async (r) => {
      await pre(r);
      const n = await restart(r);
      try {
        await run(r, n);
        await n.csms.settle(300);
        (r.csms.frames as any).push(...n.csms.frames);
      } finally {
        await n.dispose();
      }
    },
    opts,
  );
withNext(
  "restart-stop",
  async (_r, n) => {
    n.cp.updateConnectorStatus(1, OCPPStatus.Charging);
    await settle(n);
    await n.stopAndSettle();
    await n.cp.startTransaction("NEW", 1);
    await settle(n);
    await n.stopAndSettle();
  },
  (r) => charging(r),
);
withNext(
  "restart-remote-stop",
  async (_r, n) => {
    await n.remoteStop();
  },
  (r) => charging(r),
);
withNext(
  "restart-scheduled-avail",
  async (_r, n) => {
    await n.stopAndSettle();
  },
  async (r) => {
    await charging(r);
    await changeAvail(r, "Inoperative", 1);
    await settle(r);
  },
);
withNext(
  "restart-start-unanswered",
  async (_r, n) => {
    await n.stopAndSettle();
  },
  async (r) => {
    r.csms.responders.StartTransaction = () => "silent";
    r.csms.responders.TransactionEvent = () => "silent";
    r.plugIn();
    await settle(r);
    await r.cp.startTransaction("A", 1);
    await settle(r);
  },
);
withNext(
  "restart-closed-attached",
  async (_r, n) => {
    await n.cp.startTransaction("NEW", 1);
    await settle(n);
    await n.stopAndSettle();
  },
  async (r) => {
    await charging(r);
    r.cp.cleanTransaction(1);
    await settle(r);
  },
);
