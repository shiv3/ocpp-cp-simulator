// Regression cases: connection loss, remote start, authorization verdicts, periodic meter values.
/* eslint-disable @typescript-eslint/no-explicit-any --
   these cases reach into station internals (configuration, listeners, runtime
   snapshots) that the public types do not expose */
import { OCPPStatus } from "../../../cp/domain/types/OcppTypes";
import { VirtualClock } from "../../../cp/shared/clock";
import type { Rig } from "../rig";
import {
  authorizeRemote,
  both,
  c16,
  cfg,
  changeAvail,
  charging,
  restart,
  settle,
  two,
  wait,
} from "./helpers";

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
