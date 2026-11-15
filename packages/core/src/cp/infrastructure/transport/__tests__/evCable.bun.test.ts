import { describe, expect, it } from "bun:test";
import type {
  StopTransactionRequestV16,
  TransactionEventRequestV201,
} from "@ocpp-cp-simulator/ocpp/index";
import {
  answerTo,
  startMockCsms,
  type MockCsms,
  type OcppFrame,
} from "./mockCsms";
import {
  answerEverythingElse,
  bootedChargePoint,
  callOf,
  callsOf,
} from "./stationHarness";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { OCPPStatus } from "../../../domain/types/OcppTypes";
import { getTemplateById } from "../../../../utils/scenarioTemplates";
import { ScenarioExecutor } from "../../../application/scenario/ScenarioExecutor";
import { createScenarioExecutorCallbacks } from "../../../application/scenario/ScenarioRuntime";

/**
 * #453 — the EV and cable model. A plug-in, an unplug and the EV's readiness
 * are domain operations (`ChargePoint.evPlugIn`, `evDisconnected`,
 * `evSetReady`); the status, transaction and wire effects are the existing
 * handlers'. Clause ids: OCPP 1.6 §4.9 transitions A2 (plug inserted: Available to
 * Preparing), B1 (plug removed), C4 / D3 (Charging and SuspendedEV) and the
 * StopTransactionOnEVSideDisconnect text of §4.10; 2.0.1 E09 / E10 (EV side
 * disconnect).
 */

const statusOf = (status: string) => (frame: OcppFrame) =>
  frame[2] === "StatusNotification" &&
  frame[0] === 2 &&
  ((frame[3] as { status?: string }).status === status ||
    (frame[3] as { connectorStatus?: string }).connectorStatus === status);

const indexAfter = (csms: MockCsms, after: number) => (frame: OcppFrame) =>
  csms.received.indexOf(frame) > after;

/** A Heartbeat sent now and seen: every frame queued before it is on the wire. */
async function sentinel(cp: ChargePoint, csms: MockCsms): Promise<void> {
  const before = csms.received.length - 1;
  cp.sendHeartbeat();
  await csms.waitForFrame(
    (frame) => callOf("Heartbeat")(frame) && indexAfter(csms, before)(frame),
  );
}

const statusesSince = (csms: MockCsms, since: number): string[] =>
  csms.received
    .slice(since + 1)
    .filter(callOf("StatusNotification"))
    .map(
      (frame) =>
        (frame[3] as { status?: string; connectorStatus?: string }).status ??
        (frame[3] as { connectorStatus?: string }).connectorStatus ??
        "",
    );

async function v16Station(
  csms: MockCsms,
  id: string,
  stopOnEvSideDisconnect = true,
): Promise<{ cp: ChargePoint; stopAnswering: () => void }> {
  const cp = await bootedChargePoint(csms, id, "OCPP-1.6J");
  cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
  cp.configuration.applyChange(
    "StopTransactionOnEVSideDisconnect",
    String(stopOnEvSideDisconnect),
  );
  const stopAnswering = answerEverythingElse(csms, ["StartTransaction"]);
  await sentinel(cp, csms); // the boot's own StatusNotifications are on the wire
  return { cp, stopAnswering };
}

async function startV16(cp: ChargePoint, csms: MockCsms): Promise<void> {
  cp.startTransaction("TAG-453", 1);
  const start = await csms.waitForCall("StartTransaction");
  csms.replyCallResult(start.messageId, {
    transactionId: 4530,
    idTagInfo: { status: "Accepted" },
  });
  await csms.waitForFrame(statusOf("Charging"));
}

async function v201Station(
  csms: MockCsms,
  id: string,
  stopOnEvSideDisconnect = true,
): Promise<{ cp: ChargePoint; stopAnswering: () => void }> {
  const cp = await bootedChargePoint(csms, id, "OCPP-2.0.1");
  cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
  cp.configuration.applyChange(
    "StopTransactionOnEVSideDisconnect",
    String(stopOnEvSideDisconnect),
  );
  const stopAnswering = answerEverythingElse(csms, []);
  await sentinel(cp, csms);
  return { cp, stopAnswering };
}

const transactionEvents = (csms: MockCsms): TransactionEventRequestV201[] =>
  callsOf(csms, "TransactionEvent").map(
    (frame) => frame[3] as TransactionEventRequestV201,
  );

async function startV201(cp: ChargePoint, csms: MockCsms): Promise<void> {
  await cp.startTransaction("TAG-453", 1);
  await csms.waitForFrame(
    (frame) =>
      callOf("TransactionEvent")(frame) &&
      (frame[3] as TransactionEventRequestV201).eventType === "Started",
  );
  cp.updateConnectorStatus(1, OCPPStatus.Charging);
}

describe("EV cable model on OCPP 1.6 (#453)", () => {
  it("plug-in while idle reports Preparing once and is idempotent", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v16Station(csms, "CP16-CABLE-IN");
    try {
      const connector = cp.getConnector(1)!;
      expect(connector.evConnection).toBe("disconnected");
      const before = csms.received.length - 1;

      cp.evPlugIn(1);
      cp.evPlugIn(1);

      await csms.waitForFrame(
        (f) => statusOf("Preparing")(f) && indexAfter(csms, before)(f),
      );
      await sentinel(cp, csms);
      expect(statusesSince(csms, before)).toEqual(["Preparing"]);
      expect(connector.status).toBe(OCPPStatus.Preparing);
      expect(connector.evConnection).toBe("connected-ready");
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("plug-out while idle returns Preparing to Available and records the unplug", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v16Station(csms, "CP16-CABLE-OUT");
    try {
      cp.evPlugIn(1);
      await csms.waitForFrame(statusOf("Preparing"));
      const before = csms.received.length - 1;

      cp.evDisconnected(1);

      await csms.waitForFrame(
        (f) => statusOf("Available")(f) && indexAfter(csms, before)(f),
      );
      expect(cp.getConnector(1)?.evConnection).toBe("disconnected");
      expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Available);
      expect(callsOf(csms, "StopTransaction")).toHaveLength(0);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("plug-out of an idle Available connector sends nothing", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v16Station(csms, "CP16-CABLE-NOP");
    try {
      const before = csms.received.length - 1;
      cp.evDisconnected(1);
      await sentinel(cp, csms);
      expect(statusesSince(csms, before)).toEqual([]);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("plug-in does not lift an Unavailable connector, and the unplug does not either", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v16Station(csms, "CP16-CABLE-UNAV");
    try {
      cp.updateConnectorStatus(1, OCPPStatus.Unavailable);
      await csms.waitForFrame(statusOf("Unavailable"));
      const before = csms.received.length - 1;

      cp.evPlugIn(1);
      expect(cp.getConnector(1)?.evConnection).toBe("connected-ready");
      cp.evDisconnected(1);
      expect(cp.getConnector(1)?.evConnection).toBe("disconnected");

      await sentinel(cp, csms);
      expect(statusesSince(csms, before)).toEqual([]);
      expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Unavailable);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("plug-in does not lift a Faulted connector, and the unplug does not either", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v16Station(csms, "CP16-CABLE-FAULT");
    try {
      cp.updateConnectorStatus(1, OCPPStatus.Faulted);
      await csms.waitForFrame(statusOf("Faulted"));
      const before = csms.received.length - 1;

      cp.evPlugIn(1);
      expect(cp.getConnector(1)?.evConnection).toBe("connected-ready");
      cp.evDisconnected(1);
      expect(cp.getConnector(1)?.evConnection).toBe("disconnected");

      await sentinel(cp, csms);
      expect(statusesSince(csms, before)).toEqual([]);
      expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Faulted);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("plug-in does not lift a Reserved connector, and the unplug keeps the reservation", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v16Station(csms, "CP16-CABLE-RES");
    try {
      csms.send([
        2,
        "rn",
        "ReserveNow",
        {
          connectorId: 1,
          expiryDate: new Date(Date.now() + 600_000).toISOString(),
          idTag: "TAG-453",
          reservationId: 32,
        },
      ]);
      await csms.waitForFrame(statusOf("Reserved"));
      const before = csms.received.length - 1;

      cp.evPlugIn(1);
      expect(cp.getConnector(1)?.evConnection).toBe("connected-ready");
      cp.evDisconnected(1);
      expect(cp.getConnector(1)?.evConnection).toBe("disconnected");

      await sentinel(cp, csms);
      expect(statusesSince(csms, before)).toEqual([]);
      expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Reserved);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("plug-in while powered off records the cable and changes no status", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v16Station(csms, "CP16-CABLE-OFF");
    try {
      cp.powerLoss();
      expect(cp.poweredOff).toBe(true);
      const connector = cp.getConnector(1)!;
      const statusWhileOff = connector.status;
      const before = csms.received.length - 1;

      cp.evPlugIn(1);

      expect(connector.evConnection).toBe("connected-ready");
      expect(connector.status).toBe(statusWhileOff);
      expect(connector.status).not.toBe(OCPPStatus.Preparing);
      expect(statusesSince(csms, before)).toEqual([]);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("plug-out during a transaction stops it with EVDisconnected (StopTransactionOnEVSideDisconnect=true)", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v16Station(csms, "CP16-CABLE-STOP");
    try {
      cp.evPlugIn(1);
      await startV16(cp, csms);

      cp.evDisconnected(1);

      const stop = (await csms.waitForCall("StopTransaction"))
        .payload as StopTransactionRequestV16;
      expect(stop.reason).toBe("EVDisconnected");
      expect(cp.getConnector(1)?.evConnection).toBe("disconnected");
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("plug-out during a transaction with the key off suspends it and keeps the transaction", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v16Station(
      csms,
      "CP16-CABLE-KEEP",
      false,
    );
    try {
      cp.evPlugIn(1);
      await startV16(cp, csms);

      cp.evDisconnected(1);

      await csms.waitForFrame(statusOf("SuspendedEV"));
      await sentinel(cp, csms);
      expect(callsOf(csms, "StopTransaction")).toHaveLength(0);
      expect(cp.getConnector(1)?.hasRunningTransaction).toBe(true);
      expect(cp.getConnector(1)?.evConnection).toBe("disconnected");
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("EV not ready suspends the transaction and ready resumes Charging", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v16Station(csms, "CP16-CABLE-READY");
    try {
      cp.evPlugIn(1);
      await startV16(cp, csms);
      const connector = cp.getConnector(1)!;

      cp.evSetReady(1, false);
      await csms.waitForFrame(statusOf("SuspendedEV"));
      expect(connector.evConnection).toBe("connected-not-ready");
      expect(connector.energyOfferSuspended).toBe(true);
      expect(connector.hasRunningTransaction).toBe(true);

      const before = csms.received.length - 1;
      cp.evSetReady(1, false); // idempotent
      cp.evSetReady(1, true);
      await csms.waitForFrame(
        (f) => statusOf("Charging")(f) && indexAfter(csms, before)(f),
      );
      await sentinel(cp, csms);
      expect(statusesSince(csms, before)).toEqual(["Charging"]);
      expect(connector.evConnection).toBe("connected-ready");
      expect(connector.energyOfferSuspended).toBe(false);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  // #871: an EV that does not ask for energy when the transaction starts is
  // SuspendedEV from the start (1.6 §4.9 B4), never Charging first.
  it("a start for a not-ready EV goes Preparing to SuspendedEV, and ready resumes Charging", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v16Station(csms, "CP16-NOT-READY");
    try {
      cp.evPlugIn(1);
      cp.evSetReady(1, false);
      await csms.waitForFrame(statusOf("Preparing"));
      const before = csms.received.length - 1;

      cp.startTransaction("TAG-871", 1);
      const start = await csms.waitForCall("StartTransaction");
      csms.replyCallResult(start.messageId, {
        transactionId: 8710,
        idTagInfo: { status: "Accepted" },
      });
      await csms.waitForFrame(
        (f) => statusOf("SuspendedEV")(f) && indexAfter(csms, before)(f),
      );
      await sentinel(cp, csms);
      expect(statusesSince(csms, before)).toEqual(["SuspendedEV"]);
      const connector = cp.getConnector(1)!;
      expect(connector.energyOfferSuspended).toBe(true);

      const resumed = csms.received.length - 1;
      cp.evSetReady(1, true);
      await csms.waitForFrame(
        (f) => statusOf("Charging")(f) && indexAfter(csms, resumed)(f),
      );
      expect(connector.status).toBe(OCPPStatus.Charging);
      expect(connector.energyOfferSuspended).toBe(false);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("readiness without a cable is refused, and without a transaction it is only recorded", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v16Station(csms, "CP16-CABLE-NOEV");
    try {
      expect(() => cp.evSetReady(1, false)).toThrow(/no EV plugged in/);
      cp.evPlugIn(1);
      await csms.waitForFrame(statusOf("Preparing"));
      const before = csms.received.length - 1;
      cp.evSetReady(1, false);
      await sentinel(cp, csms);
      expect(statusesSince(csms, before)).toEqual([]);
      expect(cp.getConnector(1)?.evConnection).toBe("connected-not-ready");
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("a reset does not invent a cable transition on an idle plugged-in connector", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v16Station(csms, "CP16-CABLE-REBOOT");
    try {
      cp.evPlugIn(1);
      await csms.waitForFrame(statusOf("Preparing"));
      const before = csms.received.length - 1;

      cp.applyRemoteReset("Soft");
      await csms.waitForFrame(
        (f) => callOf("BootNotification")(f) && indexAfter(csms, before)(f),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(statusesSince(csms, before)).not.toContain("Available");
      expect(cp.getConnector(1)?.evConnection).toBe("connected-ready");
      expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Preparing);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });
});

describe("EV cable model on OCPP 2.0.1 (#453)", () => {
  it("plug-in reports Occupied; plug-out reports Available", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v201Station(csms, "CP201-CABLE-IN");
    try {
      const before = csms.received.length - 1;
      cp.evPlugIn(1);
      await csms.waitForFrame(
        (f) => statusOf("Occupied")(f) && indexAfter(csms, before)(f),
      );
      expect(cp.getConnector(1)?.evConnection).toBe("connected-ready");

      const mid = csms.received.length - 1;
      cp.evDisconnected(1);
      await csms.waitForFrame(
        (f) => statusOf("Available")(f) && indexAfter(csms, mid)(f),
      );
      expect(transactionEvents(csms)).toHaveLength(0);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("a re-plug after a plug-out reports Occupied again", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v201Station(csms, "CP201-CABLE-RE");
    try {
      const before = csms.received.length - 1;
      cp.evPlugIn(1);
      await csms.waitForFrame(
        (f) => statusOf("Occupied")(f) && indexAfter(csms, before)(f),
      );
      const mid = csms.received.length - 1;
      cp.evDisconnected(1);
      await csms.waitForFrame(
        (f) => statusOf("Available")(f) && indexAfter(csms, mid)(f),
      );

      cp.evPlugIn(1);

      await sentinel(cp, csms);
      expect(statusesSince(csms, before)).toEqual([
        "Occupied",
        "Available",
        "Occupied",
      ]);
      expect(cp.getConnector(1)?.evConnection).toBe("connected-ready");
      expect(transactionEvents(csms)).toHaveLength(0);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("EV not ready and ready carry one TransactionEvent(Updated) each", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v201Station(csms, "CP201-CABLE-READY");
    try {
      cp.evPlugIn(1);
      await startV201(cp, csms);
      await csms.waitForFrame(
        (f) =>
          callOf("TransactionEvent")(f) &&
          (f[3] as TransactionEventRequestV201).transactionInfo
            .chargingState === "Charging",
      );

      cp.evSetReady(1, false);
      const suspended = (
        await csms.waitForFrame(
          (f) =>
            callOf("TransactionEvent")(f) &&
            (f[3] as TransactionEventRequestV201).transactionInfo
              .chargingState === "SuspendedEV",
        )
      )[3] as TransactionEventRequestV201;
      expect(suspended.eventType).toBe("Updated");
      expect(suspended.triggerReason).toBe("ChargingStateChanged");

      const resumedFrom = csms.received.length - 1;
      cp.evSetReady(1, true);
      await csms.waitForFrame(
        (f) =>
          callOf("TransactionEvent")(f) &&
          (f[3] as TransactionEventRequestV201).transactionInfo
            .chargingState === "Charging" &&
          csms.received.indexOf(f) > resumedFrom,
      );
      const states = transactionEvents(csms).map(
        (e) => e.transactionInfo.chargingState,
      );
      expect(states.filter((s) => s === "SuspendedEV")).toHaveLength(1);
      expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Charging);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  // #846: E02.FR.13 gives every Started a chargingState, and
  // ChargingStateEnumType has `Idle` for "no connection between EV and EVSE".
  // An idToken-first start (E03) is not Charging before the cable is in; the
  // plug-in then reports EVConnected and the energy offer Charging.
  it("idToken first: Started reports Idle, then the plug-in EVConnected and Charging", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v201Station(csms, "CP201-TOKEN-1ST");
    try {
      await cp.startTransaction("TAG-846", 1);
      const started = (
        await csms.waitForFrame(
          (f) =>
            callOf("TransactionEvent")(f) &&
            (f[3] as TransactionEventRequestV201).eventType === "Started",
        )
      )[3] as TransactionEventRequestV201;
      expect(started.transactionInfo.chargingState).toBe("Idle");

      cp.evPlugIn(1);
      await csms.waitForFrame(
        (f) =>
          callOf("TransactionEvent")(f) &&
          (f[3] as TransactionEventRequestV201).transactionInfo
            .chargingState === "Charging",
      );
      expect(
        transactionEvents(csms).map((e) => [
          e.eventType,
          e.triggerReason,
          e.transactionInfo.chargingState,
        ]),
      ).toEqual([
        ["Started", "Authorized", "Idle"],
        ["Updated", "CablePluggedIn", "EVConnected"],
        ["Updated", "ChargingStateChanged", "Charging"],
      ]);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("cable first: Started still reports Charging", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v201Station(csms, "CP201-CABLE-1ST");
    try {
      cp.evPlugIn(1);
      await cp.startTransaction("TAG-846", 1);
      const started = (
        await csms.waitForFrame(
          (f) =>
            callOf("TransactionEvent")(f) &&
            (f[3] as TransactionEventRequestV201).eventType === "Started",
        )
      )[3] as TransactionEventRequestV201;
      expect(started.transactionInfo.chargingState).toBe("Charging");
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  // #871: SuspendedEV is "the EVSE is offering energy but the EV is not taking
  // any" (ChargingStateEnumType); a not-ready EV starts there, not in Charging.
  it("a start for a not-ready EV reports SuspendedEV in Started, and ready resumes Charging", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v201Station(csms, "CP201-NOT-READY");
    try {
      cp.evPlugIn(1);
      cp.evSetReady(1, false);
      await cp.startTransaction("TAG-871", 1);
      const started = (
        await csms.waitForFrame(
          (f) =>
            callOf("TransactionEvent")(f) &&
            (f[3] as TransactionEventRequestV201).eventType === "Started",
        )
      )[3] as TransactionEventRequestV201;
      expect(started.transactionInfo.chargingState).toBe("SuspendedEV");
      await sentinel(cp, csms);
      const connector = cp.getConnector(1)!;
      expect(connector.status).toBe(OCPPStatus.SuspendedEV);
      expect(connector.energyOfferSuspended).toBe(true);
      expect(transactionEvents(csms)).toHaveLength(1);

      cp.evSetReady(1, true);
      await csms.waitForFrame(
        (f) =>
          callOf("TransactionEvent")(f) &&
          (f[3] as TransactionEventRequestV201).transactionInfo
            .chargingState === "Charging",
      );
      expect(
        transactionEvents(csms).map((e) => e.transactionInfo.chargingState),
      ).toEqual(["SuspendedEV", "Charging"]);
      expect(connector.status).toBe(OCPPStatus.Charging);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("an explicit SuspendedEV start state for a ready EV holds no offer (#335 unchanged)", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v201Station(csms, "CP201-EXPLICIT");
    try {
      cp.evPlugIn(1);
      await cp.startTransaction("TAG-871", 1, undefined, undefined, {
        chargingState: "SuspendedEV",
      });
      const started = (
        await csms.waitForFrame(
          (f) =>
            callOf("TransactionEvent")(f) &&
            (f[3] as TransactionEventRequestV201).eventType === "Started",
        )
      )[3] as TransactionEventRequestV201;
      expect(started.transactionInfo.chargingState).toBe("SuspendedEV");
      await sentinel(cp, csms);
      const connector = cp.getConnector(1)!;
      expect(connector.status).toBe(OCPPStatus.Preparing);
      expect(connector.energyOfferSuspended).toBe(false);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("TxStartPoint EVConnected: the idToken for a not-ready EV reports SuspendedEV, not Charging", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v201Station(csms, "CP201-NR-EVCONN");
    try {
      cp.configuration.applyChange("TxStartPoint", "EVConnected");
      cp.evPlugIn(1);
      await csms.waitForFrame(
        (f) =>
          callOf("TransactionEvent")(f) &&
          (f[3] as TransactionEventRequestV201).eventType === "Started",
      );
      cp.evSetReady(1, false);
      await cp.startTransaction("TAG-871", 1);
      const authorized = (
        await csms.waitForFrame(
          (f) =>
            callOf("TransactionEvent")(f) &&
            (f[3] as TransactionEventRequestV201).triggerReason ===
              "Authorized",
        )
      )[3] as TransactionEventRequestV201;
      expect(authorized.transactionInfo.chargingState).toBe("SuspendedEV");
      await sentinel(cp, csms);
      const connector = cp.getConnector(1)!;
      expect(connector.status).toBe(OCPPStatus.SuspendedEV);
      expect(connector.energyOfferSuspended).toBe(true);
      expect(
        transactionEvents(csms).map((e) => e.transactionInfo.chargingState),
      ).toEqual(["EVConnected", "SuspendedEV"]);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });
});

describe("TC_003 plug-in-first template over the wire (#453)", () => {
  it("the plug-in node itself reports Preparing before StartTransaction, the plug-out ends in Available", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v16Station(csms, "CP16-TC003-CABLE");
    const answered = new Set<string>();
    const answerStart = setInterval(() => {
      for (const frame of csms.received.filter(callOf("StartTransaction"))) {
        if (answered.has(frame[1] as string)) continue;
        answered.add(frame[1] as string);
        csms.replyCallResult(frame[1] as string, {
          transactionId: 4531,
          idTagInfo: { status: "Accepted" },
        });
      }
    }, 5);
    try {
      const scenario = getTemplateById(
        "cert16-tc003-charging-plugin-first",
      )!.createScenario("CP16-TC003-CABLE", 1);
      for (const node of scenario.nodes) {
        if (node.id.startsWith("delay-")) {
          Object.assign(node.data, { delaySeconds: 0 });
        }
        if (node.id === "meter-auto") {
          Object.assign(node.data, { incrementInterval: 1, maxTime: 2 });
        }
      }
      const before = csms.received.length - 1;

      const executor = new ScenarioExecutor(
        scenario,
        createScenarioExecutorCallbacks({
          chargePoint: cp,
          connector: cp.getConnector(1)!,
        }),
      );
      await executor.start();
      await sentinel(cp, csms);

      expect(executor.getContext().state).toBe("completed");
      const sequence = csms.received
        .slice(before + 1)
        .filter((f) => f[0] === 2)
        .map((f) =>
          f[2] === "StatusNotification"
            ? `Status:${(f[3] as { status: string }).status}`
            : String(f[2]),
        )
        .filter((name) => name !== "MeterValues" && name !== "Heartbeat");
      expect(sequence.slice(0, 3)).toEqual([
        "Status:Preparing",
        "StartTransaction",
        "Status:Charging",
      ]);
      expect(sequence.filter((n) => n === "Status:Preparing")).toHaveLength(1);
      expect(sequence.at(-1)).toBe("Status:Available");
      expect(cp.getConnector(1)?.evConnection).toBe("disconnected");
    } finally {
      clearInterval(answerStart);
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  }, 20_000);
});

describe("a recorded cable never goes stale (#830 review)", () => {
  it("1.6: plug in, start, stop (auto-reset), plug in again reports Preparing again", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v16Station(csms, "CP16-STALE-RESET");
    try {
      cp.evPlugIn(1);
      await startV16(cp, csms);
      const stopped = csms.received.length - 1;
      cp.stopTransaction(1);
      await csms.waitForFrame(
        (f) => statusOf("Available")(f) && indexAfter(csms, stopped)(f),
      );
      expect(cp.getConnector(1)?.evConnection).toBe("disconnected");

      const before = csms.received.length - 1;
      cp.evPlugIn(1);
      await csms.waitForFrame(
        (f) => statusOf("Preparing")(f) && indexAfter(csms, before)(f),
      );
      expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Preparing);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("1.6: a cable plugged in while Unavailable shows Preparing once the connector is Operative again", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v16Station(csms, "CP16-STALE-AVAIL");
    try {
      csms.send([
        2,
        "ca-in",
        "ChangeAvailability",
        { connectorId: 1, type: "Inoperative" },
      ]);
      await csms.waitForFrame(statusOf("Unavailable"));
      cp.evPlugIn(1);
      expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Unavailable);

      const before = csms.received.length - 1;
      csms.send([
        2,
        "ca-op",
        "ChangeAvailability",
        { connectorId: 1, type: "Operative" },
      ]);
      await csms.waitForFrame(
        (f) => statusOf("Preparing")(f) && indexAfter(csms, before)(f),
      );
      expect(statusesSince(csms, before)).toEqual(["Preparing"]);
      expect(cp.getConnector(1)?.evConnection).toBe("connected-ready");
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("1.6: a plug-in on an Available connector that still records a cable is reported, not swallowed", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v16Station(csms, "CP16-STALE-GUARD");
    try {
      const connector = cp.getConnector(1)!;
      connector.markEvPluggedIn(); // a path that freed the connector without the cable
      expect(connector.status).toBe(OCPPStatus.Available);
      const before = csms.received.length - 1;
      cp.evPlugIn(1);
      await csms.waitForFrame(
        (f) => statusOf("Preparing")(f) && indexAfter(csms, before)(f),
      );
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("1.6: a reservation that ends with the cable in leaves Preparing, not Available", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v16Station(csms, "CP16-STALE-RES");
    try {
      csms.send([
        2,
        "rn",
        "ReserveNow",
        {
          connectorId: 1,
          expiryDate: new Date(Date.now() + 600_000).toISOString(),
          idTag: "TAG-453",
          reservationId: 31,
        },
      ]);
      await csms.waitForFrame(statusOf("Reserved"));
      cp.evPlugIn(1);
      expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Reserved);

      const before = csms.received.length - 1;
      csms.send([2, "cr", "CancelReservation", { reservationId: 31 }]);
      await csms.waitForFrame(
        (f) => statusOf("Preparing")(f) && indexAfter(csms, before)(f),
      );
      expect(statusesSince(csms, before)).toEqual(["Preparing"]);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("1.6: ReserveNow on a Preparing connector is Occupied (§5.13, §4.9)", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v16Station(csms, "CP16-RES-PREP");
    try {
      cp.evPlugIn(1);
      await csms.waitForFrame(statusOf("Preparing"));
      csms.send([
        2,
        "rn-prep",
        "ReserveNow",
        {
          connectorId: 1,
          expiryDate: new Date(Date.now() + 600_000).toISOString(),
          idTag: "OTHER",
          reservationId: 32,
        },
      ]);
      const answer = await csms.waitForFrame(answerTo("rn-prep"));
      expect((answer[2] as { status: string }).status).toBe("Occupied");
      expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Preparing);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("2.x idToken first: the plug-in is a CablePluggedIn / EVConnected update and stops EVConnectionTimeOut (E03)", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v201Station(csms, "CP201-IDTOKEN-1ST");
    try {
      cp.configuration.applyChange("ConnectionTimeOut", "1");
      await cp.startTransaction("TAG-453", 1);
      await csms.waitForFrame(
        (f) =>
          callOf("TransactionEvent")(f) &&
          (f[3] as TransactionEventRequestV201).eventType === "Started",
      );
      expect(cp.getConnector(1)?.evConnection).toBe("disconnected");

      cp.evPlugIn(1);
      const updated = (
        await csms.waitForFrame(
          (f) =>
            callOf("TransactionEvent")(f) &&
            (f[3] as TransactionEventRequestV201).triggerReason ===
              "CablePluggedIn",
        )
      )[3] as TransactionEventRequestV201;
      expect(updated.eventType).toBe("Updated");
      expect(updated.transactionInfo.chargingState).toBe("EVConnected");
      expect(cp.getConnector(1)?.evConnection).toBe("connected-ready");

      // Outlast the timeout: the transaction must still run.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await sentinel(cp, csms);
      expect(
        transactionEvents(csms).filter((e) => e.eventType === "Ended"),
      ).toHaveLength(0);
      expect(cp.getConnector(1)?.hasRunningTransaction).toBe(true);
      expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Charging);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });
});
