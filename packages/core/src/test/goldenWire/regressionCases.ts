// Regression cases for the golden wire test. Every transcript here was
// recorded on ca01d302 (before the charger engine), never on this branch: they
// pin what that commit put on the wire in situations the first set missed
// (retries, the offline queue, disconnects with follow-ups in flight, gate
// precedence, deferred availability, reservations and so on).
/* eslint-disable @typescript-eslint/no-explicit-any --
   these cases reach into station internals (configuration, listeners, runtime
   snapshots) that the public types do not expose */
import { SIGNING_CERTIFICATE } from "../../cp/domain/security/__tests__/signingCertificateFixture";
import { OCPPStatus } from "../../cp/domain/types/OcppTypes";
import { VirtualClock } from "../../cp/shared/clock";
import { resolveNetworkSimConfig } from "../../cp/infrastructure/transport/network-sim";
import type { GoldenCase as Case } from "./cases";
import { Rig, type RigOptions } from "./rig";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = (r: Rig) => r.csms.settle();
const cases: Case[] = [];
export const regressionCases = cases;
const c16 = (name: string, run: Case["run"], options?: Case["options"]) =>
  cases.push({ name: `16-${name}`, version: "1.6", run, options });
const c201 = (name: string, run: Case["run"], options?: Case["options"]) =>
  cases.push({ name: `201-${name}`, version: "2.0.1", run, options });
const c21 = (name: string, run: Case["run"], options?: Case["options"]) =>
  cases.push({ name: `21-${name}`, version: "2.1", run, options });
const both = (name: string, run: Case["run"], options?: Case["options"]) => {
  c16(name, run, options);
  c201(name, run, options);
};
const cfg = (r: Rig, k: string, v: string) =>
  (r.cp as any).configuration.applyChange(k, v);
// The key is read-only for the CSMS (ChangeConfiguration is Rejected): it is
// the station's own choice, set here the way a scenario or the CLI sets it.
const authorizeRemote = (r: Rig, on: boolean) => {
  if (!r.cp.configuration.setRuntimeValue("AuthorizeRemoteTxRequests", on)) {
    throw new Error("AuthorizeRemoteTxRequests cannot be set");
  }
};
async function charging(r: Rig, tag = "TAG-1", c = 1) {
  r.plugIn(c);
  await settle(r);
  await r.cp.startTransaction(tag, c);
  await settle(r);
  r.cp.updateConnectorStatus(c, OCPPStatus.Charging);
  await settle(r);
}
// These two return the CSMS call so a case awaits the station's answer: the
// next step then never starts before the previous exchange is on the wire,
// however slow the machine (#848).
const changeAvail = (r: Rig, type: "Operative" | "Inoperative", id?: number) =>
  r.is16
    ? r.csms.call("ChangeAvailability", { connectorId: id ?? 0, type })
    : r.csms.call("ChangeAvailability", {
        operationalStatus: type,
        ...(id === undefined ? {} : { evse: { id } }),
      });
const reserve = (r: Rig, id: number, c: number, tag: string, expiry: string) =>
  r.is16
    ? r.csms.call("ReserveNow", {
        connectorId: c,
        expiryDate: expiry,
        idTag: tag,
        reservationId: id,
      })
    : r.csms.call("ReserveNow", {
        id,
        // 0 names no EVSE: the field is left out (H01.FR.04).
        ...(c === 0 ? {} : { evseId: c }),
        expiryDateTime: expiry,
        idToken: { idToken: tag, type: "ISO14443" },
      });
const FUT = "2099-01-01T00:00:00.000Z";
const two = { connectors: 2 };

// --- connection loss with follow-ups in flight
c16("getlog-reconnect", async (r) => {
  await r.csms.call("GetLog", {
    logType: "SecurityLog",
    requestId: 7,
    log: { remoteLocation: "http://x" },
  });
  await wait(100);
  r.csms.dropConnection();
  await r.csms.waitForCall("BootNotification", { nth: 2, timeoutMs: 30000 });
  await wait(3000);
  await settle(r);
});
c16("firmware-reconnect-then-again", async (r) => {
  await r.csms.call("UpdateFirmware", {
    location: "http://x",
    retrieveDate: "2020-01-01T00:00:00.000Z",
  });
  await wait(300);
  r.csms.dropConnection();
  await r.reconnected();
  await settle(r);
  await r.csms.call("UpdateFirmware", {
    location: "http://x",
    retrieveDate: "2020-01-01T00:00:00.000Z",
  });
  await wait(9000);
  await settle(r);
});
c16("diagnostics-disconnect", async (r) => {
  await r.csms.call("GetDiagnostics", { location: r.uploadUrl() });
  r.csms.dropConnection();
  await r.reconnected();
  await settle(r);
});
// --- remote start
both("remote-authorize-first", async (r) => {
  authorizeRemote(r, true);
  await r.remoteStart("TAG-A");
  r.cp.updateConnectorStatus(1, OCPPStatus.Charging);
  await settle(r);
  await r.remoteStop();
});
both("remote-start-twice", async (r) => {
  await r.remoteStart("TAG-A");
  await r.remoteStart("TAG-B");
  await r.remoteStop();
});
// 1.6 §5.11 (errata 3.32, #728): Accepted only when a start will be attempted.
c16(
  "remote-start-without-connector-picks-free",
  async (r) => {
    await charging(r, "A", 1);
    r.plugIn(2);
    await settle(r);
    await r.csms.call("RemoteStartTransaction", { idTag: "B" });
    await settle(r);
    r.cp.stopTransaction(1);
    r.cp.stopTransaction(2);
    await settle(r);
  },
  two,
);
c16("remote-start-busy-connector-rejected", async (r) => {
  await charging(r, "A", 1);
  await r.csms.call("RemoteStartTransaction", { idTag: "B", connectorId: 1 });
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
});
c16("remote-start-faulted-connector-rejected", async (r) => {
  r.cp.updateConnectorStatus(1, OCPPStatus.Faulted);
  await settle(r);
  await r.csms.call("RemoteStartTransaction", { idTag: "B", connectorId: 1 });
  await settle(r);
});
both("remote-start-preparing", async (r) => {
  r.plugIn();
  await settle(r);
  await r.remoteStart("TAG-A");
  await r.remoteStop();
  await settle(r);
});
both("remote-start-unavailable", async (r) => {
  await changeAvail(r, "Inoperative", 1);
  await settle(r);
  await r.remoteStart("TAG-A");
  await changeAvail(r, "Operative", 1);
  await settle(r);
  await r.remoteStart("TAG-A");
  await r.remoteStop();
});
both(
  "remote-start-connector2",
  async (r) => {
    await r.remoteStart("TAG-A", 2);
    await r.remoteStart("TAG-A", 1);
    await r.remoteStop(2);
    await r.remoteStop(1);
  },
  two,
);
// --- stop before the start was answered
c16("stop-before-conf", async (r) => {
  r.csms.responders.StartTransaction = () => "silent";
  r.plugIn();
  await settle(r);
  await r.cp.startTransaction("TAG-A", 1);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
  await r.cp.startTransaction("TAG-B", 1);
  await wait(500);
});
c16("start-callerror-retry", async (r) => {
  cfg(r, "TransactionMessageAttempts", "3");
  cfg(r, "TransactionMessageRetryInterval", "1");
  r.csms.responders.StartTransaction = (_p, c) =>
    c.nth < 3
      ? { error: { code: "InternalError", description: "x" } }
      : { transactionId: 42, idTagInfo: { status: "Accepted" } };
  r.plugIn();
  await settle(r);
  await r.cp.startTransaction("TAG-A", 1);
  await wait(200);
  await r.csms.call("RemoteStopTransaction", { transactionId: 0 });
  await wait(4000);
  await settle(r);
  await r.csms.call("RemoteStopTransaction", { transactionId: 42 });
  await settle(r);
});
c16("start-callerror-stop-during-retry", async (r) => {
  cfg(r, "TransactionMessageAttempts", "3");
  cfg(r, "TransactionMessageRetryInterval", "1");
  r.csms.responders.StartTransaction = () => ({
    error: { code: "InternalError", description: "x" },
  });
  r.plugIn();
  await settle(r);
  await r.cp.startTransaction("TAG-A", 1);
  await wait(200);
  r.cp.stopTransaction(1);
  await wait(4000);
  await settle(r);
});
// #565, §3.7: a stop during a StartTransaction retry waits for the resend,
// and carries the id the CSMS assigns to it.
const startFailsOnce = (r: Rig) => {
  cfg(r, "TransactionMessageAttempts", "3");
  cfg(r, "TransactionMessageRetryInterval", "1");
  r.csms.responders.StartTransaction = (_p, c) =>
    c.nth < 2
      ? { error: { code: "InternalError", description: "x" } }
      : { transactionId: 7, idTagInfo: { status: "Accepted" } };
};
c16("start-callerror-stop-during-retry-conf", async (r) => {
  startFailsOnce(r);
  r.plugIn();
  await settle(r);
  await r.cp.startTransaction("TAG-A", 1);
  await wait(200);
  r.cp.stopTransaction(1);
  await wait(2500);
  await settle(r);
});
c16("start-callerror-unlock-during-retry", async (r) => {
  startFailsOnce(r);
  r.plugIn();
  await settle(r);
  await r.cp.startTransaction("TAG-A", 1);
  await wait(200);
  await r.csms.call("UnlockConnector", { connectorId: 1 });
  await wait(2500);
  await settle(r);
});
c16("start-callerror-meter-and-stop-during-retry", async (r) => {
  startFailsOnce(r);
  r.plugIn();
  await settle(r);
  await r.cp.startTransaction("TAG-A", 1);
  await wait(200);
  r.cp.sendMeterValue(1);
  await wait(100);
  r.cp.stopTransaction(1);
  await wait(2500);
  await settle(r);
});
c16("stop-callerror-retry", async (r) => {
  cfg(r, "TransactionMessageAttempts", "2");
  cfg(r, "TransactionMessageRetryInterval", "1");
  r.csms.responders.StopTransaction = (_p, c) =>
    c.nth < 2 ? { error: { code: "InternalError", description: "x" } } : {};
  await charging(r);
  r.cp.stopTransaction(1);
  await wait(1500);
  await settle(r);
});
// --- authorization verdicts
both("deauthorized-stop", async (r) => {
  cfg(r, "StopTransactionOnInvalidId", "true");
  const inv = r.is16
    ? { transactionId: 9, idTagInfo: { status: "Invalid" } }
    : { idTokenInfo: { status: "Invalid" } };
  r.csms.responders[r.is16 ? "StartTransaction" : "TransactionEvent"] = (
    p: any,
  ) => (r.is16 || p.eventType === "Started" ? inv : {});
  r.plugIn();
  await settle(r);
  await r.cp.startTransaction("TAG-A", 1);
  await settle(r);
  await wait(300);
});
both("deauthorized-keep", async (r) => {
  cfg(r, "StopTransactionOnInvalidId", "false");
  const inv = r.is16
    ? { transactionId: 9, idTagInfo: { status: "Invalid" } }
    : { idTokenInfo: { status: "Invalid" } };
  r.csms.responders[r.is16 ? "StartTransaction" : "TransactionEvent"] = (
    p: any,
  ) => (r.is16 || p.eventType === "Started" ? inv : {});
  r.plugIn();
  await settle(r);
  await r.cp.startTransaction("TAG-A", 1);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
});
// 1.6 errata 3.15 (§4.7, #722): MeterValueSampleInterval drives periodic
// MeterValues.req of a running transaction. Virtual time, in-memory socket.
const periodic = async (r: Rig, clock: VirtualClock, seconds: number) => {
  for (let i = 0; i < seconds; i++) {
    await clock.advanceBy(1000);
    await settle(r);
  }
};
const periodicClock = new VirtualClock();
c16(
  "meter-periodic-default",
  async (r) => {
    r.plugIn();
    await settle(r);
    await r.cp.startTransaction("TAG-A", 1);
    await settle(r);
    await periodic(r, periodicClock, 125);
    r.cp.stopTransaction(1);
    await settle(r);
  },
  { memory: true, simulation: { clock: periodicClock, seed: "g722" } },
);
const periodicOffClock = new VirtualClock();
c16(
  "meter-periodic-disabled",
  async (r) => {
    cfg(r, "MeterValueSampleInterval", "0");
    r.plugIn();
    await settle(r);
    await r.cp.startTransaction("TAG-A", 1);
    await settle(r);
    await periodic(r, periodicOffClock, 125);
    r.cp.stopTransaction(1);
    await settle(r);
  },
  { memory: true, simulation: { clock: periodicOffClock, seed: "g722" } },
);
// With an auto-meter curve (a host wires the scheduler's tick to the station
// as the CLI and the web console do) the curve moves the register every 10 s,
// and the samples still go out once per MeterValueSampleInterval.
const periodicCurveClock = new VirtualClock();
c16(
  "meter-periodic-with-curve",
  async (r) => {
    const connector = r.cp.getConnector(1)!;
    connector.setOnMeterValueSend((id) => r.cp.sendScheduledMeterValue(id));
    connector.autoMeterValueConfig = {
      enabled: true,
      curvePoints: [
        { time: 0, value: 0 },
        { time: 1800, value: 50 },
      ],
      intervalSeconds: 10,
      autoCalculateInterval: false,
    };
    r.plugIn();
    await settle(r);
    await r.cp.startTransaction("TAG-A", 1);
    await settle(r);
    await periodic(r, periodicCurveClock, 125);
    r.cp.stopTransaction(1);
    await settle(r);
  },
  { memory: true, simulation: { clock: periodicCurveClock, seed: "g722" } },
);
// §3.7: "When offline, the Charge Point MUST queue any transaction-related
// messages", periodic MeterValues included. The two samples taken while the
// link is down are flushed in order after the reconnect (#722).
const periodicOfflineClock = new VirtualClock();
c16(
  "meter-periodic-offline",
  async (r) => {
    r.plugIn();
    await settle(r);
    await r.cp.startTransaction("TAG-A", 1);
    await settle(r);
    r.cp.disconnect();
    await periodicOfflineClock.advanceBy(130_000);
    await r.connectAndBoot();
    await settle(r);
    await periodic(r, periodicOfflineClock, 5);
    r.cp.stopTransaction(1);
    await settle(r);
  },
  { memory: true, simulation: { clock: periodicOfflineClock, seed: "g722" } },
);
// #847: Rig.reconnected() across a reconnect of the in-memory transport
// (FakeCsms.attachMemoryClient sets lastFrameAt like the WebSocket `open`
// path): the second boot and the samples that follow are on the wire.
const memoryReconnectClock = new VirtualClock();
c16(
  "memory-transport-reconnect",
  async (r) => {
    r.plugIn();
    await settle(r);
    await r.cp.startTransaction("TAG-A", 1);
    await settle(r);
    r.csms.dropConnection();
    await r.reconnected();
    await settle(r);
    await periodic(r, memoryReconnectClock, 65);
    r.cp.stopTransaction(1);
    await settle(r);
  },
  { memory: true, simulation: { clock: memoryReconnectClock, seed: "g847" } },
);
// A transaction restored after a restart is sampled again, from the restart.
const periodicRestartClock = new VirtualClock();
const periodicRestartNextClock = new VirtualClock();
c16(
  "meter-periodic-after-restart",
  async (r) => {
    r.plugIn();
    await settle(r);
    await r.cp.startTransaction("TAG-A", 1);
    await settle(r);
    const n = await restart(r, {
      memory: true,
      simulation: { clock: periodicRestartNextClock, seed: "g722" },
    });
    try {
      await periodic(n, periodicRestartNextClock, 65);
      n.cp.stopTransaction(1);
      await settle(n);
      await n.csms.settle(300);
      (r.csms.frames as any).push(...n.csms.frames);
    } finally {
      await n.dispose();
    }
  },
  { memory: true, simulation: { clock: periodicRestartClock, seed: "g722" } },
);
// errata 3.15 (§4.7) still asks for a sample every interval when the
// StartTransaction.req was answered with a CALLERROR; errata 3.18 (§4.8)
// names the id they carry: -1 until a conf gives one.
const periodicStartErrorClock = new VirtualClock();
c16(
  "meter-periodic-start-callerror",
  async (r) => {
    r.csms.responders.StartTransaction = () =>
      ({ error: { code: "InternalError", description: "x" } }) as any;
    r.plugIn();
    await settle(r);
    await r.cp.startTransaction("TAG-A", 1);
    await settle(r);
    await periodic(r, periodicStartErrorClock, 200);
    r.cp.stopTransaction(1);
    await settle(r);
    await periodic(r, periodicStartErrorClock, 60);
  },
  {
    memory: true,
    simulation: { clock: periodicStartErrorClock, seed: "g722" },
  },
);
// A ChangeConfiguration of the interval mid-transaction re-arms the sampler
// at once (#839; before, it applied to the next transaction).
const periodicChangeClock = new VirtualClock();
c16(
  "meter-periodic-change-configuration",
  async (r) => {
    r.plugIn();
    await settle(r);
    await r.cp.startTransaction("TAG-A", 1);
    await settle(r);
    await r.csms.call("ChangeConfiguration", {
      key: "MeterValueSampleInterval",
      value: "20",
    });
    await settle(r);
    await periodic(r, periodicChangeClock, 65);
    r.cp.stopTransaction(1);
    await settle(r);
    await r.cp.startTransaction("TAG-B", 1);
    await settle(r);
    await periodic(r, periodicChangeClock, 45);
    r.cp.stopTransaction(1);
    await settle(r);
  },
  { memory: true, simulation: { clock: periodicChangeClock, seed: "g722" } },
);
// #839, 1.6 §9.1.19: an interval of 0 means no sampled data is sent; setting
// it mid-transaction stops the running sampler.
const periodicZeroClock = new VirtualClock();
c16(
  "meter-periodic-change-to-zero",
  async (r) => {
    r.plugIn();
    await settle(r);
    await r.cp.startTransaction("TAG-A", 1);
    await settle(r);
    await periodic(r, periodicZeroClock, 65);
    await r.csms.call("ChangeConfiguration", {
      key: "MeterValueSampleInterval",
      value: "0",
    });
    await settle(r);
    await periodic(r, periodicZeroClock, 130);
    r.cp.stopTransaction(1);
    await settle(r);
  },
  { memory: true, simulation: { clock: periodicZeroClock, seed: "g722" } },
);
// A scenario's own meter strategy (an auto-increment node) keeps its own
// interval next to the station's sampler: both send.
const periodicScenarioClock = new VirtualClock();
c16(
  "meter-periodic-with-scenario-increment",
  async (r) => {
    const connector = r.cp.getConnector(1)!;
    connector.setOnMeterValueSend((id) => r.cp.sendScheduledMeterValue(id));
    r.plugIn();
    await settle(r);
    await r.cp.startTransaction("TAG-A", 1);
    await settle(r);
    connector.startManualMeterStrategy({
      kind: "increment",
      intervalSeconds: 25,
      incrementValue: 100,
    });
    await periodic(r, periodicScenarioClock, 65);
    r.cp.stopTransaction(1);
    await settle(r);
  },
  { memory: true, simulation: { clock: periodicScenarioClock, seed: "g722" } },
);
// 1.6 errata 3.17 (§4.8): MaxEnergyOnInvalidId > 0 lets the vehicle charge
// first, so the connector goes to Charging before the energy stops.
c16("deauthorized-keep-with-allowance", async (r) => {
  cfg(r, "StopTransactionOnInvalidId", "false");
  cfg(r, "MaxEnergyOnInvalidId", "500");
  r.csms.responders.StartTransaction = () => ({
    transactionId: 9,
    idTagInfo: { status: "Invalid" },
  });
  r.plugIn();
  await settle(r);
  await r.cp.startTransaction("TAG-A", 1);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
});
// --- availability
both(
  "avail-whole-two-connectors",
  async (r) => {
    await charging(r, "A", 1);
    await charging(r, "B", 2);
    await changeAvail(r, "Inoperative");
    await settle(r);
    r.cp.stopTransaction(1);
    await settle(r);
    await r.remoteStart("C", 1);
    r.cp.stopTransaction(2);
    await settle(r);
    await changeAvail(r, "Operative");
    await settle(r);
  },
  two,
);
both(
  "avail-one-busy",
  async (r) => {
    await charging(r, "A", 1);
    await changeAvail(r, "Inoperative");
    await settle(r);
    await r.remoteStart("B", 2);
    await settle(r);
    r.cp.stopTransaction(1);
    await settle(r);
    r.cp.stopTransaction(2);
    await settle(r);
  },
  two,
);
both("avail-flip-while-charging", async (r) => {
  await charging(r);
  await changeAvail(r, "Inoperative", 1);
  await settle(r);
  await changeAvail(r, "Operative", 1);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
  await changeAvail(r, "Inoperative", 1);
  await settle(r);
  await changeAvail(r, "Inoperative", 1);
  await settle(r);
});
// G03.FR.03 / G04.FR.04 for the station: the same state is Accepted during a
// transaction, and Operative drops the pending Inoperative.
c201("avail-station-same-state-while-charging", async (r) => {
  await charging(r);
  await changeAvail(r, "Operative");
  await settle(r);
  await changeAvail(r, "Inoperative");
  await settle(r);
  await changeAvail(r, "Operative");
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
});
both("avail-no-autoreset", async (r) => {
  r.cp.getConnector(1)!.autoResetToAvailable = false;
  await charging(r);
  await changeAvail(r, "Inoperative", 1);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
  await changeAvail(r, "Operative", 1);
  await settle(r);
});
both("avail-unknown", async (r) => {
  await changeAvail(r, "Inoperative", 9);
  await settle(r);
});
// --- reservations
both("res-other-tag-start", async (r) => {
  await reserve(r, 5, 1, "OWNER", FUT);
  await settle(r);
  await r.cp.startTransaction("OTHER", 1);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
  await r.csms.call("CancelReservation", { reservationId: 5 });
  await settle(r);
});
both("res-expire-lazy", async (r) => {
  await reserve(r, 6, 1, "OWNER", new Date(Date.now() + 700).toISOString());
  await settle(r);
  await wait(900);
  await r.cp.startTransaction("OWNER", 1);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
});
both("res-cancel-after-plug", async (r) => {
  await reserve(r, 7, 1, "OWNER", FUT);
  await settle(r);
  r.plugIn();
  await settle(r);
  await r.csms.call("CancelReservation", { reservationId: 7 });
  await settle(r);
  await r.csms.call("CancelReservation", { reservationId: 7 });
  await settle(r);
});
both("res-remote-start-reserved", async (r) => {
  await reserve(r, 8, 1, "OWNER", FUT);
  await settle(r);
  await r.remoteStart("OWNER");
  await r.remoteStop();
  await reserve(r, 9, 1, "OWNER", "2020-01-01T00:00:00.000Z");
  await settle(r);
  await reserve(r, 9, 1, "OWNER", FUT);
  await settle(r);
  await reserve(r, 9, 1, "OWNER2", FUT);
  await settle(r);
});
c16("res-connector0", async (r) => {
  await reserve(r, 10, 0, "OWNER", FUT);
  await settle(r);
});
// #595: connector 0 is accepted once the station supports it, and a ReserveNow
// with a held reservationId moves that reservation to the other connector.
c16("res-connector0-supported", async (r) => {
  r.cp.configuration.setRuntimeValue("ReserveConnectorZeroSupported", true);
  await reserve(r, 20, 0, "OWNER", FUT);
  await settle(r);
});
c16(
  "res-replace-moves-connector",
  async (r) => {
    await reserve(r, 21, 1, "OWNER", FUT);
    await settle(r);
    await reserve(r, 21, 2, "OWNER", FUT);
    await settle(r);
  },
  two,
);
// #595: a connector-0 reservation is its idTag's. A stranger starting on the
// other connector neither consumes it (no reservationId on that
// StartTransaction.req) nor cancels it; the owner's start does carry it.
c16(
  "res-connector0-stranger-starts",
  async (r) => {
    r.cp.configuration.setRuntimeValue("ReserveConnectorZeroSupported", true);
    await reserve(r, 22, 0, "OWNER", FUT);
    await settle(r);
    await r.remoteStart("STRANGER", 2);
    await settle(r);
    await r.remoteStart("OWNER", 1);
    await settle(r);
  },
  two,
);
// #595, 1.6 §5.13: a connector-0 reservation keeps one connector free for its
// idTag for its whole validity. A stranger takes the first of two connectors,
// is Rejected on the last one (RemoteStartTransaction.conf Rejected, no
// StartTransaction.req), and the owner still gets it, carrying the reservationId.
c16(
  "res-connector0-keeps-a-connector",
  async (r) => {
    r.cp.configuration.setRuntimeValue("ReserveConnectorZeroSupported", true);
    await reserve(r, 23, 0, "OWNER", FUT);
    await settle(r);
    await r.remoteStart("STRANGER", 1);
    await settle(r);
    await r.remoteStart("STRANGER2", 2);
    await settle(r);
    await r.remoteStart("OWNER", 2);
    await settle(r);
  },
  two,
);
both("res-then-inoperative", async (r) => {
  await reserve(r, 11, 1, "OWNER", FUT);
  await settle(r);
  await changeAvail(r, "Inoperative", 1);
  await settle(r);
  await r.csms.call("CancelReservation", { reservationId: 11 });
  await settle(r);
  await reserve(r, 12, 1, "OWNER", FUT);
  await settle(r);
});
// #731 / #712, 1.6 §5.13 and 2.0.1 H01.FR.16/17: a reserved connector that
// becomes Faulted loses its reservation (2.x reports Removed); after recovery a
// start carries no reservationId.
both("res-removed-faulted", async (r) => {
  await reserve(r, 13, 1, "OWNER", FUT);
  await settle(r);
  r.cp.updateConnectorStatus(1, OCPPStatus.Faulted);
  await settle(r);
  await r.csms.call("CancelReservation", { reservationId: 13 });
  await settle(r);
  r.cp.updateConnectorStatus(1, OCPPStatus.Available);
  await settle(r);
  await r.cp.startTransaction("OWNER", 1);
  await settle(r);
});
// #731 / #712: ChangeAvailability for the whole station ends every reservation.
both(
  "res-station-inoperative",
  async (r) => {
    await reserve(r, 14, 1, "OWNER", FUT);
    await settle(r);
    await reserve(r, 15, 2, "OWNER2", FUT);
    await settle(r);
    await changeAvail(r, "Inoperative");
    await settle(r);
    await r.csms.call("CancelReservation", { reservationId: 14 });
    await settle(r);
    await r.csms.call("CancelReservation", { reservationId: 15 });
    await settle(r);
  },
  two,
);
// #731 / #712: a reservation that names no connector ends with the station
// going Unavailable.
both(
  "res-unspecified-inoperative",
  async (r) => {
    r.cp.configuration.setRuntimeValue("ReserveConnectorZeroSupported", true);
    await reserve(r, 16, 0, "OWNER", FUT);
    await settle(r);
    await changeAvail(r, "Inoperative");
    await settle(r);
    await r.csms.call("CancelReservation", { reservationId: 16 });
    await settle(r);
  },
  two,
);
// #721 / #711, 1.6 §5.13 and 2.0.1 H03.FR.04: a tag of another group is refused
// (nothing but the Authorize on the wire, the reservation stays); a tag whose
// parent idTag / groupIdToken is the reservation's starts and carries the
// reservation id.
const groupResponders = {
  "1.6": {
    Authorize: (p: any) => ({
      idTagInfo: {
        status: "Accepted",
        ...(p.idTag === "MEMBER" ? { parentIdTag: "GROUP" } : {}),
      },
    }),
  },
  "2.0.1": {
    Authorize: (p: any) => ({
      idTokenInfo: {
        status: "Accepted",
        ...(p.idToken.idToken === "MEMBER"
          ? { groupIdToken: { idToken: "GROUP", type: "Central" } }
          : {}),
      },
    }),
  },
};
for (const version of ["1.6", "2.0.1"] as const) {
  (version === "1.6" ? c16 : c201)(
    "res-parent-start",
    async (r) => {
      if (r.is16) {
        await r.csms.call("ReserveNow", {
          connectorId: 1,
          expiryDate: FUT,
          idTag: "OWNER",
          parentIdTag: "GROUP",
          reservationId: 17,
        });
      } else {
        await r.csms.call("ReserveNow", {
          id: 17,
          evseId: 1,
          expiryDateTime: FUT,
          idToken: { idToken: "OWNER", type: "ISO14443" },
          groupIdToken: { idToken: "GROUP", type: "Central" },
        });
      }
      await settle(r);
      await r.cp.startTransaction("STRANGER", 1);
      await settle(r);
      await r.cp.startTransaction("MEMBER", 1);
      await settle(r);
      r.cp.stopTransaction(1);
      await settle(r);
    },
    { responders: groupResponders[version] },
  );
}
// F01.FR.21/22: a RequestStartTransaction whose groupIdToken is the
// reservation's group starts on the reserved EVSE with the reservation id,
// also when the station does not know the token's group (a Central token is
// never sent to Authorize) (#818, #660).
for (const [, add] of [
  ["2.0.1", c201],
  ["2.1", c21],
] as const) {
  add("res-request-start-group", async (r) => {
    await r.csms.call("ReserveNow", {
      id: 19,
      evseId: 1,
      expiryDateTime: FUT,
      idToken: { idToken: "OWNER", type: "ISO14443" },
      groupIdToken: { idToken: "GROUP", type: "Central" },
    });
    await settle(r);
    await r.csms.call("RequestStartTransaction", {
      idToken: { idToken: "MEMBER", type: "Central" },
      groupIdToken: { idToken: "GROUP", type: "Central" },
      remoteStartId: 5,
      evseId: 1,
    });
    await settle(r);
    await r.remoteStop();
    await settle(r);
  });
}
// #721, 1.6 §5.13: a RemoteStartTransaction for another tag on a reserved
// connector answers Rejected; the reservation stays.
c16("res-remote-start-other-tag", async (r) => {
  await reserve(r, 18, 1, "OWNER", FUT);
  await settle(r);
  await r.remoteStart("OTHER");
  await r.csms.call("CancelReservation", { reservationId: 18 });
  await settle(r);
});
// #710, 2.0.1 H01.FR.02: the same id again replaces the reservation, also on
// another EVSE, which goes back to Available.
c201(
  "res-replace-moves-evse",
  async (r) => {
    await reserve(r, 21, 1, "OWNER", FUT);
    await settle(r);
    await reserve(r, 21, 2, "OWNER", FUT);
    await settle(r);
  },
  two,
);
// #710, H01.FR.11: an EVSE that is not Available (a cable plugged in, or
// reserved under another id) answers Occupied and keeps its status.
c201(
  "res-occupied-not-available",
  async (r) => {
    r.plugIn(1);
    await settle(r);
    await reserve(r, 24, 1, "OWNER", FUT);
    await settle(r);
    await reserve(r, 25, 2, "OWNER", FUT);
    await settle(r);
    await reserve(r, 26, 2, "OWNER2", FUT);
    await settle(r);
  },
  two,
);
// #709, H01.FR.19: without ReservationCtrlr.NonEvseSpecific a ReserveNow
// without evseId is Rejected.
c201("res-unspecified-rejected", async (r) => {
  await reserve(r, 27, 0, "OWNER", FUT);
  await settle(r);
});
// #709, H01.FR.04/07/20: with it, reservations are taken while an EVSE stays
// free for each; the EVSEs report Reserved once the reservations equal them,
// and a token's session consumes its reservation on any EVSE.
c201(
  "res-unspecified-supported",
  async (r) => {
    r.cp.configuration.setRuntimeValue("ReserveConnectorZeroSupported", true);
    await reserve(r, 28, 0, "OWNER", FUT);
    await settle(r);
    await reserve(r, 29, 0, "OWNER2", FUT);
    await settle(r);
    await reserve(r, 30, 0, "OWNER3", FUT);
    await settle(r);
    await r.cp.startTransaction("STRANGER", 2);
    await settle(r);
    await r.cp.startTransaction("OWNER2", 2);
    await settle(r);
  },
  two,
);
// --- reset
c16(
  "reset-soft-two",
  async (r) => {
    await charging(r, "A", 1);
    await charging(r, "B", 2);
    await r.csms.call("Reset", { type: "Soft" });
    await wait(1500);
    await settle(r);
  },
  two,
);
c16(
  "reset-hard-two",
  async (r) => {
    await charging(r, "A", 1);
    await charging(r, "B", 2);
    await r.csms.call("Reset", { type: "Hard" });
    await r.csms.waitForCall("BootNotification", { nth: 2, timeoutMs: 30000 });
    await settle(r);
  },
  two,
);
c201(
  "reset-evse",
  async (r) => {
    await charging(r, "A", 1);
    await charging(r, "B", 2);
    await r.csms.call("Reset", { type: "Immediate", evseId: 2 });
    await wait(600);
    await settle(r);
    await r.csms.call("Reset", { type: "OnIdle", evseId: 1 });
    await r.csms.call("Reset", { type: "OnIdle", evseId: 2 });
    await wait(600);
    await settle(r);
    await r.csms.call("Reset", { type: "Immediate", evseId: 9 });
    await settle(r);
  },
  two,
);
// #635: a Reset OnIdle answered Scheduled boots once the last targeted
// transaction ended; nothing running answers Accepted and boots at once; an
// Immediate reset drops the pending one.
c201("reset-onidle-idle", async (r) => {
  await r.csms.call("Reset", { type: "OnIdle" });
  await wait(600);
  await settle(r);
});
c201(
  "reset-onidle-waits-for-last",
  async (r) => {
    await charging(r, "A", 1);
    await charging(r, "B", 2);
    await r.csms.call("Reset", { type: "OnIdle" });
    await settle(r);
    r.cp.stopTransaction(1);
    await wait(600);
    await settle(r);
    r.cp.stopTransaction(2);
    await wait(600);
    await settle(r);
  },
  two,
);
c201("reset-onidle-then-immediate", async (r) => {
  await charging(r);
  await r.csms.call("Reset", { type: "OnIdle" });
  await settle(r);
  await r.csms.call("Reset", { type: "Immediate" });
  await wait(600);
  await settle(r);
  await charging(r, "B");
  r.cp.stopTransaction(1);
  await wait(600);
  await settle(r);
});
c201("reset-immediate-resume", async (r) => {
  await charging(r);
  await r.csms.call("Reset", { type: "ImmediateAndResume" });
  await wait(600);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
});
// --- unlock
both("unlock-failed-with-tx", async (r) => {
  await charging(r);
  (r.cp.getConnector(1) as any).unlockResponse = "UnlockFailed";
  const p = r.is16 ? { connectorId: 1 } : { evseId: 1, connectorId: 1 };
  await r.csms.call("UnlockConnector", p);
  await settle(r);
  await r.csms.call("UnlockConnector", p);
  await settle(r);
});
// --- physical
both("ev-side-disconnect-keep", async (r) => {
  cfg(r, "StopTransactionOnEVSideDisconnect", "false");
  await charging(r);
  (r.cp as any).evDisconnected(1);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
});
both("ev-side-disconnect-stop", async (r) => {
  cfg(r, "StopTransactionOnEVSideDisconnect", "true");
  await charging(r);
  (r.cp as any).evDisconnected(1);
  await settle(r);
});
both("connection-timeout", async (r) => {
  cfg(r, "ConnectionTimeOut", "1");
  r.plugIn();
  await wait(1500);
  await settle(r);
  r.plugIn();
  await settle(r);
  await r.remoteStart("T");
  await wait(1500);
  await settle(r);
});
both("back-to-back", async (r) => {
  await charging(r);
  r.cp.stopTransaction(1);
  await settle(r);
  await charging(r, "TAG-2");
  r.cp.stopTransaction(1, "Local");
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
});
both("sync-start-stop", async (r) => {
  r.plugIn();
  await settle(r);
  const p = r.cp.startTransaction("A", 1);
  r.cp.stopTransaction(1, "EmergencyStop");
  await p;
  const q = r.cp.startTransaction("B", 1);
  await q;
  await settle(r);
  r.cp.stopTransaction(1, "PowerLoss");
  await settle(r);
});
both("clean-then-start", async (r) => {
  await charging(r);
  r.cp.cleanTransaction(1);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
  await r.cp.startTransaction("B", 1);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
});
both("nested-stop-in-listener", async (r) => {
  let done = false;
  r.cp.events.on("connectorStatusChange", (e: any) => {
    if (e.status === OCPPStatus.Charging && !done) {
      done = true;
      r.cp.stopTransaction(1, "Other");
    }
  });
  await charging(r);
  await settle(r);
});
both("nested-start-on-preparing", async (r) => {
  let done = false;
  r.cp.events.on("connectorStatusChange", (e: any) => {
    if (e.status === OCPPStatus.Preparing && !done) {
      done = true;
      void r.cp.startTransaction("N", 1);
    }
  });
  r.plugIn();
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
});
both("transaction-started-listener-stops", async (r) => {
  r.cp.events.on("transactionStarted", () => r.cp.stopTransaction(1, "Other"));
  r.plugIn();
  await settle(r);
  await r.cp.startTransaction("N", 1);
  await settle(r);
});
both("soc-start", async (r) => {
  r.plugIn();
  await settle(r);
  await r.cp.startTransaction("A", 1, 50, 20);
  await settle(r);
  r.cp.updateConnectorStatus(1, OCPPStatus.Charging);
  (r.cp as any).sendMeterValue?.(1);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
  await r.cp.startTransaction("B", 1);
  await settle(r);
  r.cp.stopTransaction(1);
  await settle(r);
});
both("offline-start-stop", async (r) => {
  r.plugIn();
  await settle(r);
  r.cp.disconnect();
  await wait(200);
  await r.cp.startTransaction("OFF", 1);
  await wait(100);
  r.cp.stopTransaction(1);
  await wait(100);
  await r.connectAndBoot();
  await settle(r);
});
both("offline-mid-tx-reconnect", async (r) => {
  await charging(r);
  r.csms.dropConnection();
  await r.reconnected();
  await settle(r);
  await r.remoteStop();
  await settle(r);
});
both("disconnect-with-remote-stop-noack", async (r) => {
  await charging(r);
  const id = r.transactionId(1);
  void (r.is16
    ? r.csms.callNoWait("RemoteStopTransaction", { transactionId: id })
    : r.csms.callNoWait("RequestStopTransaction", { transactionId: id }));
  r.csms.dropConnection();
  await r.reconnected();
  await settle(r);
});

// --- round 2
const latency = (r: Rig, ms = 500) =>
  r.cp.setNetworkSimConfig(
    resolveNetworkSimConfig(
      {
        enabled: true,
        seed: 1,
        rules: { l: { type: "latency", direction: "upstream", delayMs: ms } },
      } as any,
      null,
      "CP-GOLDEN",
    ) as any,
  );
const dropAndBack = async (r: Rig, nth = 2) => {
  r.csms.dropConnection();
  await r.reconnected(nth);
  await settle(r);
};
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
both("ns-remote-stop-drop", async (r) => {
  await charging(r);
  latency(r);
  const id = r.transactionId(1);
  void (r.is16
    ? r.csms.callNoWait("RemoteStopTransaction", { transactionId: id })
    : r.csms.callNoWait("RequestStopTransaction", { transactionId: id }));
  await wait(100);
  await dropAndBack(r);
  // 2.x sends one CALL at a time (#708): three CALLs under 500 ms latency
  // need more than 1 s.
  await wait(r.is16 ? 1000 : 3500);
  await settle(r);
});
both("ns-remote-start-drop", async (r) => {
  latency(r);
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
  await wait(100);
  await dropAndBack(r);
  // 2.x sends one CALL at a time (#708): three CALLs under 500 ms latency
  // need more than 1 s.
  await wait(r.is16 ? 1000 : 3500);
  await settle(r);
});
both("ns-reset-drop", async (r) => {
  await charging(r);
  latency(r);
  r.csms.callNoWait("Reset", { type: r.is16 ? "Soft" : "Immediate" });
  await wait(100);
  await dropAndBack(r);
  // 2.x sends one CALL at a time (#708): three CALLs under 500 ms latency
  // need more than 1 s.
  await wait(r.is16 ? 1000 : 3500);
  await settle(r);
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
c201("trigger-status-idle-after-request", async (r) => {
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
c201("malformed-calls", async (r) => {
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
    await wait(30);
  }
  await settle(r);
});
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
c16("malformed-calls", async (r) => {
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
    await wait(30);
  }
  await settle(r);
});
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

// --- restart: the snapshot goes through the row format and a new station
const roundTrip = (snap: any) => {
  const row = JSON.parse(JSON.stringify(snap));
  const tx = row.transaction;
  if (!tx) return row;
  return {
    ...row,
    transaction: {
      ...tx,
      startTime: new Date(tx.startTime),
      ...(tx.stopTime ? { stopTime: new Date(tx.stopTime) } : {}),
    },
  };
};
async function restart(r: Rig, options: Partial<RigOptions> = {}) {
  const snaps = [...r.cp.connectors.values()].map(
    (c) => [c.id, roundTrip(c.snapshotRuntime())] as const,
  );
  const next = await Rig.create({
    version: r.version,
    noConnect: true,
    connectors: r.cp.connectors.size,
    ...options,
  });
  for (const [id, snap] of snaps)
    next.cp.getConnector(id)!.restoreRuntimeSnapshot(snap);
  await next.connectAndBoot();
  return next;
}
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
    n.cp.stopTransaction(1);
    await settle(n);
    await n.cp.startTransaction("NEW", 1);
    await settle(n);
    n.cp.stopTransaction(1);
    await settle(n);
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
    n.cp.stopTransaction(1);
    await settle(n);
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
    n.cp.stopTransaction(1);
    await settle(n);
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
    n.cp.stopTransaction(1);
    await settle(n);
  },
  async (r) => {
    await charging(r);
    r.cp.cleanTransaction(1);
    await settle(r);
  },
);

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
const FAR_PAST = "2020-01-01T00:00:00.000Z";
const stationAvail = (r: Rig, type: "Operative" | "Inoperative") =>
  r.is16
    ? r.csms.call("ChangeAvailability", { connectorId: 0, type })
    : r.csms.call("ChangeAvailability", { operationalStatus: type });
const statusOf = (f: { payload: unknown }) =>
  (f.payload as { status?: string }).status;

// A StopTransaction / TransactionEvent(Ended) carries the stop time, and every
// timestamp keeps its millisecond form (strict normalization).
for (const v of ["1.6", "2.0.1"] as const) {
  strict("timestamps-start-meter-stop", v, async (r) => {
    r.plugIn();
    await settle(r);
    await r.cp.startTransaction("TAG-T", 1);
    await settle(r);
    await wait(2000);
    r.cp.setMeterValue(1, 500);
    r.cp.sendMeterValue(1);
    await settle(r);
    await wait(2000);
    r.cp.stopTransaction(1);
    await settle(r);
  });
}
strict("message-ids-are-uuids", "1.6", async (r) => {
  await charging(r);
  r.cp.stopTransaction(1);
  await settle(r);
});

// The offline queue is flushed in order, with the original timestamps.
strict("offline-flush-order", "1.6", async (r) => {
  await charging(r);
  r.cp.disconnect();
  await wait(200);
  for (const wh of [100, 200, 300]) {
    r.cp.setMeterValue(1, wh);
    r.cp.sendMeterValue(1);
    await wait(1100);
  }
  r.cp.stopTransaction(1);
  await wait(100);
  await r.connectAndBoot();
  await settle(r);
});
strict("offline-flush-order", "2.0.1", async (r) => {
  await charging(r);
  r.cp.disconnect();
  await wait(200);
  for (const wh of [100, 200, 300]) {
    r.cp.setMeterValue(1, wh);
    r.cp.sendMeterValue(1);
    await wait(1100);
  }
  r.cp.stopTransaction(1);
  await wait(100);
  await r.connectAndBoot();
  await settle(r);
});

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
both(
  "heartbeat-pace",
  async (r) => {
    await wait(2500);
    await settle(r);
  },
  {
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

// --- 1.6 security events (#734, whitepaper A04.FR.01/02) -------------------
// With SecurityProfile >= 1 the station reports its startup and resets.
const profile1 = (cp: {
  configuration: {
    applyChange: (
      k: string,
      v: string,
      o?: { bypassGuard?: boolean },
    ) => unknown;
  };
}) => {
  // Profile 1 needs the AuthorizationKey the transport sends (#724, §7.2).
  cp.configuration.applyChange(
    "AuthorizationKey",
    "00112233445566778899aabbccddeeff",
  );
  // The case sets the starting profile; the A05 guard is for CSMS requests.
  cp.configuration.applyChange("SecurityProfile", "1", { bypassGuard: true });
};
const resetCase = (type: "Soft" | "Hard") => async (r: Rig) => {
  await r.csms.call("Reset", { type });
  await r.csms.waitForCall("BootNotification", { nth: 2, timeoutMs: 30000 });
  await wait(300);
  await settle(r);
};
// A Reset ends with the boot, then ResetOrReboot, then StartupOfTheDevice.
c16("reset-soft-security-events", resetCase("Soft"), {
  beforeConnect: profile1,
});
c16("reset-hard-security-events", resetCase("Hard"), {
  beforeConnect: profile1,
});
// A reconnect after a dropped socket, and an accepted TriggerMessage of a
// BootNotification, do not report a device startup that did not happen.
c16(
  "reconnect-no-startup-event",
  async (r) => {
    r.csms.dropConnection();
    await r.csms.waitForCall("BootNotification", { nth: 2, timeoutMs: 30000 });
    await wait(300);
    await r.csms.call("TriggerMessage", {
      requestedMessage: "BootNotification",
    });
    await r.csms.waitForCall("BootNotification", { nth: 3, timeoutMs: 30000 });
    await wait(300);
    await settle(r);
  },
  { beforeConnect: profile1 },
);
// Power returning is a start of the device (A04.FR.01): the Accepted boot
// after a power loss reports StartupOfTheDevice again (#734).
c16(
  "power-restore-startup-event",
  async (r) => {
    r.cp.powerLoss();
    await wait(300);
    r.cp.restorePower();
    await r.csms.waitForCall("BootNotification", { nth: 2, timeoutMs: 30000 });
    await wait(300);
    await settle(r);
  },
  { beforeConnect: profile1 },
);
// A critical event raised while disconnected is delivered after the next
// Accepted boot with the timestamp it was raised with.
c16(
  "security-event-queued-offline",
  async (r) => {
    r.cp.disconnect();
    await wait(200);
    const raisedAt = Date.now();
    await r.cp.sendSecurityEventNotification(
      "TamperDetectionActivated",
      "case",
    );
    // A non-critical type is not kept.
    await r.cp.sendSecurityEventNotification("InvalidMessages", "case");
    await wait(1200);
    await r.connectAndBoot();
    await wait(300);
    const sent = r.csms.frames.find(
      (f) =>
        f.dir === "CP>" &&
        f.action === "SecurityEventNotification" &&
        (f.payload as { type?: string }).type === "TamperDetectionActivated",
    );
    const stamp = Date.parse(
      (sent?.payload as { timestamp?: string }).timestamp ?? "",
    );
    if (!(stamp >= raisedAt - 1000 && stamp <= raisedAt + 500)) {
      throw new Error(
        `the queued event lost its timestamp (${stamp} vs ${raisedAt})`,
      );
    }
    await settle(r);
  },
  { beforeConnect: profile1 },
);
// #455 power loss: the socket vanishes with the transaction still running;
// after the power returns the station boots, then resumes (the default) or
// reports the transaction ended with reason PowerLoss (1.6 StopTransaction;
// 2.x E17.FR.21 Ended + AbnormalCondition), stamped with the loss.
both("power-loss-resume", async (r) => {
  await charging(r);
  r.cp.powerLoss();
  await wait(300);
  r.cp.restorePower({ transactions: "resume" });
  await r.csms.waitForCall("BootNotification", { nth: 2, timeoutMs: 30000 });
  await settle(r);
});
both("power-loss-end", async (r) => {
  await charging(r);
  r.cp.powerLoss();
  await wait(300);
  r.cp.restorePower({ transactions: "end" });
  await r.csms.waitForCall("BootNotification", { nth: 2, timeoutMs: 30000 });
  await settle(r);
});
// Messages queued before the loss go first, then the recovery.
both("power-loss-queued-then-end", async (r) => {
  await charging(r);
  r.cp.disconnect();
  await wait(200);
  r.cp.setMeterValue(1, 500);
  // 1.x: MeterValues; 2.x: TransactionEvent(Updated), queued as offline.
  r.cp.txUpdatedMeterValues = true;
  r.cp.sendScheduledMeterValue(1);
  await wait(100);
  r.cp.powerLoss();
  await wait(300);
  r.cp.restorePower({ transactions: "end" });
  await r.csms.waitForCall("BootNotification", { nth: 2, timeoutMs: 30000 });
  await settle(r);
});
