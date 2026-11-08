import { describe, expect, it } from "bun:test";
import type {
  StopTransactionRequestV16,
  TransactionEventRequestV201,
} from "@ocpp-cp-sim/ocpp/index";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
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
