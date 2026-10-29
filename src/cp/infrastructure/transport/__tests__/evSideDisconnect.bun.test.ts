import { describe, expect, it } from "bun:test";
import type {
  StopTransactionRequestV16,
  TransactionEventRequestV201,
} from "../../../../ocpp";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import {
  answerEverythingElse,
  bootedChargePoint,
  callOf,
  callsOf,
} from "./stationHarness";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { OCPPStatus } from "../../../domain/types/OcppTypes";

/**
 * #488 — an EV-side disconnect (`ChargePoint.evDisconnected`) during a
 * transaction follows `StopTransactionOnEVSideDisconnect`
 * (`TxCtrlr.StopTxOnEVSideDisconnect` on 2.x):
 * - true: the transaction stops with `EVDisconnected` (1.6 §3.7 / §9.1.31,
 *   2.0.1 E09: Ended, triggerReason EVCommunicationLost);
 * - false: the transaction is kept and the connector is SuspendedEV (1.6),
 *   2.0.1 E10: Updated, chargingState SuspendedEV, triggerReason
 *   EVCommunicationLost.
 * Without a transaction the unplug sends StatusNotification Available, as the
 * console's Unplug button did before.
 */

const statusOf = (status: string) => (frame: OcppFrame) =>
  frame[0] === 2 &&
  frame[2] === "StatusNotification" &&
  ((frame[3] as { status?: string; connectorStatus?: string }).status ===
    status ||
    (frame[3] as { connectorStatus?: string }).connectorStatus === status);

const indexAfter = (csms: MockCsms, after: number) => (frame: OcppFrame) =>
  csms.received.indexOf(frame) > after;

/** A Heartbeat sent now and seen by the CSMS: every frame queued before it
 *  is on the wire, so an absence checked afterwards is real. */
async function sentinel(cp: ChargePoint, csms: MockCsms): Promise<void> {
  const before = csms.received.length - 1;
  cp.sendHeartbeat();
  await csms.waitForFrame(
    (frame) => callOf("Heartbeat")(frame) && indexAfter(csms, before)(frame),
  );
}

async function v16ChargingStation(
  csms: MockCsms,
  id: string,
  stopOnEvSideDisconnect: boolean,
): Promise<{ cp: ChargePoint; stopAnswering: () => void }> {
  const cp = await bootedChargePoint(csms, id, "OCPP-1.6J");
  cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
  cp.configuration.applyChange(
    "StopTransactionOnEVSideDisconnect",
    String(stopOnEvSideDisconnect),
  );
  const stopAnswering = answerEverythingElse(csms, ["StartTransaction"]);
  return { cp, stopAnswering };
}

async function startV16Transaction(
  cp: ChargePoint,
  csms: MockCsms,
): Promise<void> {
  cp.startTransaction("TAG-488", 1);
  const start = await csms.waitForCall("StartTransaction");
  csms.replyCallResult(start.messageId, {
    transactionId: 4880,
    idTagInfo: { status: "Accepted" },
  });
  await csms.waitForFrame(statusOf("Charging"));
}

async function v201ChargingStation(
  csms: MockCsms,
  id: string,
  stopOnEvSideDisconnect: boolean,
): Promise<{ cp: ChargePoint; stopAnswering: () => void }> {
  const cp = await bootedChargePoint(csms, id, "OCPP-2.0.1");
  cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
  cp.configuration.applyChange(
    "StopTransactionOnEVSideDisconnect",
    String(stopOnEvSideDisconnect),
  );
  const stopAnswering = answerEverythingElse(csms, []);
  return { cp, stopAnswering };
}

async function startV201Transaction(
  cp: ChargePoint,
  csms: MockCsms,
): Promise<void> {
  await cp.startTransaction("TAG-488", 1);
  await csms.waitForFrame(
    (frame) =>
      callOf("TransactionEvent")(frame) &&
      (frame[3] as TransactionEventRequestV201).eventType === "Started",
  );
  cp.updateConnectorStatus(1, OCPPStatus.Charging);
}

const transactionEvents = (csms: MockCsms): TransactionEventRequestV201[] =>
  callsOf(csms, "TransactionEvent").map(
    (frame) => frame[3] as TransactionEventRequestV201,
  );

describe("EV-side disconnect on OCPP 1.6 (#488)", () => {
  it("StopTransactionOnEVSideDisconnect=true stops the transaction with EVDisconnected", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v16ChargingStation(
      csms,
      "CP16-EVSD-TRUE",
      true,
    );
    try {
      await startV16Transaction(cp, csms);
      const before = csms.received.length - 1;

      cp.evDisconnected(1);

      const stop = await csms.waitForCall("StopTransaction");
      const stopPayload = stop.payload as StopTransactionRequestV16;
      expect(stopPayload.transactionId).toBe(4880);
      expect(stopPayload.reason).toBe("EVDisconnected");
      await csms.waitForFrame(
        (frame) =>
          statusOf("Finishing")(frame) && indexAfter(csms, before)(frame),
      );
      expect(cp.getConnector(1)?.hasRunningTransaction).toBe(false);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("StopTransactionOnEVSideDisconnect=false keeps the transaction and reports SuspendedEV", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v16ChargingStation(
      csms,
      "CP16-EVSD-FALSE",
      false,
    );
    try {
      await startV16Transaction(cp, csms);
      const before = csms.received.length - 1;

      cp.evDisconnected(1);

      await csms.waitForFrame(
        (frame) =>
          statusOf("SuspendedEV")(frame) && indexAfter(csms, before)(frame),
      );
      await sentinel(cp, csms);
      expect(callsOf(csms, "StopTransaction")).toHaveLength(0);
      const after = csms.received.slice(before + 1);
      expect(after.filter(statusOf("Available"))).toHaveLength(0);
      expect(after.filter(statusOf("Finishing"))).toHaveLength(0);
      const connector = cp.getConnector(1);
      expect(connector?.hasRunningTransaction).toBe(true);
      expect(connector?.transaction?.id).toBe(4880);
      expect(connector?.status).toBe(OCPPStatus.SuspendedEV);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  for (const key of [true, false]) {
    it(`without a transaction (key=${key}) the unplug reports Available`, async () => {
      const csms = startMockCsms();
      const { cp, stopAnswering } = await v16ChargingStation(
        csms,
        `CP16-EVSD-IDLE-${key}`,
        key,
      );
      try {
        cp.updateConnectorStatus(1, OCPPStatus.Preparing);
        await csms.waitForFrame(statusOf("Preparing"));
        const before = csms.received.length - 1;

        cp.evDisconnected(1);

        await csms.waitForFrame(
          (frame) =>
            statusOf("Available")(frame) && indexAfter(csms, before)(frame),
        );
        await sentinel(cp, csms);
        expect(callsOf(csms, "StopTransaction")).toHaveLength(0);
        expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Available);
      } finally {
        stopAnswering();
        cp.disconnect();
        await csms.stop();
      }
    });
  }
});

describe("EV-side disconnect on OCPP 2.0.1 (#488)", () => {
  it("StopTxOnEVSideDisconnect=true ends the transaction (E09)", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v201ChargingStation(
      csms,
      "CP201-EVSD-TRUE",
      true,
    );
    try {
      await startV201Transaction(cp, csms);

      cp.evDisconnected(1);

      const ended = (
        await csms.waitForFrame(
          (frame) =>
            callOf("TransactionEvent")(frame) &&
            (frame[3] as TransactionEventRequestV201).eventType === "Ended",
        )
      )[3] as TransactionEventRequestV201;
      expect(ended.triggerReason).toBe("EVCommunicationLost");
      expect(ended.transactionInfo.stoppedReason).toBe("EVDisconnected");
      expect(cp.getConnector(1)?.hasRunningTransaction).toBe(false);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("StopTxOnEVSideDisconnect=false suspends the transaction (E10)", async () => {
    const csms = startMockCsms();
    const { cp, stopAnswering } = await v201ChargingStation(
      csms,
      "CP201-EVSD-FALSE",
      false,
    );
    try {
      await startV201Transaction(cp, csms);
      await csms.waitForFrame(
        (frame) =>
          callOf("TransactionEvent")(frame) &&
          (frame[3] as TransactionEventRequestV201).transactionInfo
            .chargingState === "Charging",
      );

      cp.evDisconnected(1);

      const updated = (
        await csms.waitForFrame(
          (frame) =>
            callOf("TransactionEvent")(frame) &&
            (frame[3] as TransactionEventRequestV201).transactionInfo
              .chargingState === "SuspendedEV",
        )
      )[3] as TransactionEventRequestV201;
      expect(updated.eventType).toBe("Updated");
      expect(updated.triggerReason).toBe("EVCommunicationLost");
      await sentinel(cp, csms);
      const events = transactionEvents(csms);
      // One Updated for the suspension: the status change it comes with is
      // de-duplicated, not sent a second time as ChargingStateChanged.
      expect(
        events.filter((e) => e.transactionInfo.chargingState === "SuspendedEV"),
      ).toHaveLength(1);
      expect(events.filter((e) => e.eventType === "Ended")).toHaveLength(0);
      const connector = cp.getConnector(1);
      expect(connector?.hasRunningTransaction).toBe(true);
      expect(connector?.status).toBe(OCPPStatus.SuspendedEV);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  for (const key of [true, false]) {
    it(`without a transaction (key=${key}) the unplug reports Available`, async () => {
      const csms = startMockCsms();
      const { cp, stopAnswering } = await v201ChargingStation(
        csms,
        `CP201-EVSD-IDLE-${key}`,
        key,
      );
      try {
        cp.updateConnectorStatus(1, OCPPStatus.Preparing);
        await csms.waitForFrame(statusOf("Occupied"));
        const before = csms.received.length - 1;

        cp.evDisconnected(1);

        await csms.waitForFrame(
          (frame) =>
            statusOf("Available")(frame) && indexAfter(csms, before)(frame),
        );
        await sentinel(cp, csms);
        expect(transactionEvents(csms)).toHaveLength(0);
        expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Available);
      } finally {
        stopAnswering();
        cp.disconnect();
        await csms.stop();
      }
    });
  }
});
