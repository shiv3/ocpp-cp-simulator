import { describe, expect, it } from "bun:test";
import type { TransactionEventRequestV201 } from "../../../../ocpp";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { ChargePointEvents } from "../../../domain/charge-point/ChargePointEvents";
import { OCPPStatus } from "../../../domain/types/OcppTypes";
import {
  answerTo,
  startMockCsms,
  type MockCsms,
  type OcppFrame,
} from "./mockCsms";
import { bootedChargePoint, callOf } from "./stationHarness";

/**
 * #490, OCPP 2.0.1 / 2.1 E13: a CALLERROR answering a TransactionEvent is a
 * failure to process it. The station resends the same message under a new
 * message id, up to `OCPPCommCtrlr.MessageAttempts[TransactionEvent]`
 * transmissions, then discards it and carries on. The transaction keeps
 * running throughout. The wait between transmissions
 * (`MessageAttemptInterval[TransactionEvent]` x transmissions so far) is
 * covered with fake timers in OCPPMessageHandlerV201.transactionRetry.test.ts;
 * here it is set to 0.
 */

const started = (frame: OcppFrame): boolean =>
  frame[0] === 2 &&
  frame[2] === "TransactionEvent" &&
  (frame[3] as TransactionEventRequestV201).eventType === "Started";

/** OCPP 2.0.1 §2.1.10/2.1.11, 2.1 §2.1.12: the E13 settings are
 *  `OCPPCommCtrlr.<name>` with `variableInstance = "TransactionEvent"`. */
async function setVariables(
  csms: MockCsms,
  values: Record<string, string>,
): Promise<void> {
  const id = `sv-${Object.keys(values).join("-")}`;
  csms.send([
    2,
    id,
    "SetVariables",
    {
      setVariableData: Object.entries(values).map(([name, value]) => ({
        attributeValue: value,
        component: { name: "OCPPCommCtrlr" },
        variable: { name, instance: "TransactionEvent" },
      })),
    },
  ]);
  const answer = await csms.waitForFrame(answerTo(id));
  expect(answer[2]).toEqual({
    setVariableResult: Object.keys(values).map((name) => ({
      attributeStatus: "Accepted",
      attributeType: "Actual",
      component: { name: "OCPPCommCtrlr" },
      variable: { name, instance: "TransactionEvent" },
    })),
  });
}

/** Once the Heartbeat answer is processed, every frame the CSMS sent before
 *  it has been too, and any CALL they provoked synchronously is on the wire. */
async function sentinel(cp: ChargePoint, csms: MockCsms): Promise<void> {
  cp.sendHeartbeat();
  const heartbeat = await csms.waitForCall("Heartbeat");
  csms.replyCallResult(heartbeat.messageId, {
    currentTime: new Date().toISOString(),
  });
  await new Promise((r) => setTimeout(r, 50));
}

describe.each(["OCPP-2.0.1", "OCPP-2.1"])(
  "%s TransactionEvent CALLERROR (#490, E13)",
  (version) => {
    it("resends Started, then discards it with the transaction still running", async () => {
      const csms = startMockCsms();
      const cp = await bootedChargePoint(csms, `CP-490-RETRY`, version);
      cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
      const rejected: Array<ChargePointEvents["transactionMessageRejected"]> =
        [];
      const discarded: Array<ChargePointEvents["transactionMessageDiscarded"]> =
        [];
      cp.events.on("transactionMessageRejected", (e) => rejected.push(e));
      cp.events.on("transactionMessageDiscarded", (e) => discarded.push(e));
      const failures: unknown[] = [];
      cp.events.on("transactionStartFailed", (e) => failures.push(e));
      try {
        await setVariables(csms, {
          MessageAttempts: "2",
          MessageAttemptInterval: "0",
        });
        expect(cp.configuration.transactionMessageAttempts()).toBe(2);
        expect(cp.configuration.transactionMessageRetryInterval()).toBe(0);

        void cp.startTransaction("TAG-490", 1);
        const first = await csms.waitForFrame(started);
        // The EV draws power: the rejection must not move it off Charging.
        cp.updateConnectorStatus(1, OCPPStatus.Charging);
        csms.send([4, first[1], "InternalError", "boom", {}]);
        const second = await csms.waitForFrame(
          (f) => started(f) && f[1] !== first[1],
        );
        expect(second[3]).toEqual(first[3]);
        csms.send([4, second[1], "FormationViolation", "bad", {}]);
        await sentinel(cp, csms);

        const transactionId = (first[3] as TransactionEventRequestV201)
          .transactionInfo.transactionId;
        expect(rejected).toEqual([
          {
            connectorId: 1,
            transactionId,
            eventType: "Started",
            errorCode: "InternalError",
            attempt: 1,
          },
          {
            connectorId: 1,
            transactionId,
            eventType: "Started",
            errorCode: "FormationViolation",
            attempt: 2,
          },
        ]);
        expect(discarded).toEqual([
          {
            connectorId: 1,
            transactionId,
            eventType: "Started",
            errorCode: "FormationViolation",
            attempts: 2,
          },
        ]);
        expect(csms.received.filter(started)).toHaveLength(2);
        expect(failures).toEqual([]);
        const connector = cp.getConnector(1)!;
        expect(connector.status).toBe(OCPPStatus.Charging);
        expect(connector.transaction?.cpTransactionId).toBe(transactionId);
        expect(connector.transaction?.stopTime).toBeNull();
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it("stops resending once the CSMS accepts a retry", async () => {
      const csms = startMockCsms();
      const cp = await bootedChargePoint(csms, `CP-490-OK`, version);
      cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
      let discarded = 0;
      cp.events.on("transactionMessageDiscarded", () => discarded++);
      try {
        await setVariables(csms, {
          MessageAttemptInterval: "0",
        });
        void cp.startTransaction("TAG-490", 1);
        const first = await csms.waitForFrame(started);
        // The EV draws power: the rejection must not move it off Charging.
        cp.updateConnectorStatus(1, OCPPStatus.Charging);
        csms.send([4, first[1], "InternalError", "boom", {}]);
        const second = await csms.waitForFrame(
          (f) => started(f) && f[1] !== first[1],
        );
        csms.replyCallResult(second[1] as string, {});
        await sentinel(cp, csms);

        expect(csms.received.filter(started)).toHaveLength(2);
        expect(discarded).toBe(0);
        expect(cp.getConnector(1)!.status).toBe(OCPPStatus.Charging);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it("refuses the flat names that are only the spec's section titles", async () => {
      const csms = startMockCsms();
      const cp = await bootedChargePoint(csms, `CP-490-FLAT`, version);
      try {
        const flat = [
          "MessageAttemptsTransactionEvent",
          "MessageAttemptIntervalTransactionEvent",
        ];
        csms.send([
          2,
          "sv-flat",
          "SetVariables",
          {
            setVariableData: flat.map((name) => ({
              attributeValue: "1",
              component: { name: "OCPPCommCtrlr" },
              variable: { name },
            })),
          },
        ]);
        const answer = await csms.waitForFrame(answerTo("sv-flat"));
        expect(answer[2]).toEqual({
          setVariableResult: flat.map((name) => ({
            attributeStatus: "UnknownVariable",
            component: { name: "OCPPCommCtrlr" },
            variable: { name },
          })),
        });
        expect(cp.configuration.transactionMessageAttempts()).toBe(3);
        expect(cp.configuration.transactionMessageRetryInterval()).toBe(60);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });

    it("drops a waiting resend when the charge point disconnects", async () => {
      const csms = startMockCsms();
      const cp = await bootedChargePoint(csms, `CP-490-CLOSE`, version);
      cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
      cp.configuration.applyChange("TransactionMessageRetryInterval", "1");
      try {
        void cp.startTransaction("TAG-490", 1);
        const first = await csms.waitForFrame(started);
        csms.send([4, first[1], "InternalError", "boom", {}]);
        await sentinel(cp, csms);
        cp.disconnect();
        // Back online before the 1 s resend is due: only a cancelled timer
        // keeps the old Started off the new connection.
        const oldBoots = new Set(
          csms.received.filter(callOf("BootNotification")).map((f) => f[1]),
        );
        cp.connect();
        const boot = await csms.waitForFrame(
          (f) => callOf("BootNotification")(f) && !oldBoots.has(f[1]),
        );
        csms.replyCallResult(boot[1] as string, {
          status: "Accepted",
          currentTime: new Date().toISOString(),
          interval: 300,
        });
        await new Promise((r) => setTimeout(r, 1_300));
        // Still online: a Heartbeat goes through after the deadline.
        await sentinel(cp, csms);
        expect(csms.received.filter(started)).toHaveLength(1);
      } finally {
        cp.disconnect();
        await csms.stop();
      }
    });
  },
);
