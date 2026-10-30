import { describe, expect, it } from "bun:test";
import {
  isValidMeterValuesRequestV201,
  isValidTransactionEventRequestV201,
} from "../../../../ocpp/v201";
import {
  isValidMeterValuesRequestV21,
  isValidTransactionEventRequestV21,
} from "../../../../ocpp/v21";
import type { TransactionEventRequestV201 } from "../../../../ocpp";
import type { MockCsms, OcppFrame } from "./mockCsms";
import { startMockCsms } from "./mockCsms";
import {
  answerEverythingElse,
  bootedChargePoint,
  callOf,
  callsOf,
} from "./stationHarness";

/**
 * #347: with `txUpdatedMeterValues` on, an OCPP 2.x station sends the
 * scheduler's samples taken during a transaction as
 * TransactionEvent(Updated, MeterValuePeriodic) instead of MeterValues.
 * Off by default; outside a transaction, and for every MeterValues a caller
 * asks for explicitly (control plane, TriggerMessage), MeterValues stays.
 * The Started / Ended register readings say which boundary they are.
 */

const VERSIONS = [
  {
    version: "OCPP-2.0.1",
    txEvent: isValidTransactionEventRequestV201,
    meterValues: isValidMeterValuesRequestV201,
  },
  {
    version: "OCPP-2.1",
    txEvent: isValidTransactionEventRequestV21,
    meterValues: isValidMeterValuesRequestV21,
  },
] as const;

const event = (type: string) => (f: OcppFrame) =>
  callOf("TransactionEvent")(f) &&
  (f[3] as { eventType?: string }).eventType === type;

const updates = (csms: MockCsms) =>
  csms.received
    .filter(event("Updated"))
    .map((f) => f[3] as TransactionEventRequestV201);

/** Lets every frame already sent reach the mock CSMS. */
async function settle(csms: MockCsms): Promise<void> {
  const before = csms.received.length;
  csms.send([2, "sentinel-hb", "Heartbeat", {}]);
  await csms.waitForFrame((f) => f[0] !== 2 && f[1] === "sentinel-hb");
  expect(csms.received.length).toBeGreaterThan(before);
}

describe("OCPP 2.x scheduled meter samples in TransactionEvent (#347)", () => {
  for (const v of VERSIONS) {
    it(`${v.version}: on, during a transaction: Updated / MeterValuePeriodic, no MeterValues`, async () => {
      const csms = startMockCsms();
      const stop = answerEverythingElse(csms, []);
      try {
        const cp = await bootedChargePoint(
          csms,
          `CP347-on-${v.version}`,
          v.version,
        );
        expect(cp.txUpdatedMeterValues).toBe(false);
        cp.txUpdatedMeterValues = true;
        cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
        cp.startTransaction("TAG-347", 1);
        await csms.waitForFrame(event("Started"));
        cp.setMeterValue(1, 1500);

        cp.sendScheduledMeterValue(1);
        await csms.waitForFrame(event("Updated"));
        await settle(csms);

        const [updated] = updates(csms).filter(
          (u) => u.triggerReason === "MeterValuePeriodic",
        );
        expect(v.txEvent(updated)).toBe(true);
        expect(updated).toMatchObject({
          eventType: "Updated",
          triggerReason: "MeterValuePeriodic",
          evse: { id: 1, connectorId: 1 },
        });
        // Started took seqNo 0: the sample is the next event.
        expect(updated.seqNo).toBe(1);
        const samples = updated.meterValue!.flatMap((m) => m.sampledValue);
        expect(samples.length).toBeGreaterThan(0);
        expect(samples.every((s) => s.context === "Sample.Periodic")).toBe(
          true,
        );
        expect(
          samples.find(
            (s) =>
              (s.measurand ?? "Energy.Active.Import.Register") ===
              "Energy.Active.Import.Register",
          ),
        ).toMatchObject({ value: 1500, unitOfMeasure: { unit: "Wh" } });
        expect(callsOf(csms, "MeterValues")).toHaveLength(0);
        cp.disconnect();
      } finally {
        stop();
        await csms.stop();
      }
    });

    it(`${v.version}: off (the default), during a transaction: MeterValues`, async () => {
      const csms = startMockCsms();
      const stop = answerEverythingElse(csms, []);
      try {
        const cp = await bootedChargePoint(
          csms,
          `CP347-off-${v.version}`,
          v.version,
        );
        cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
        cp.startTransaction("TAG-347", 1);
        await csms.waitForFrame(event("Started"));

        cp.sendScheduledMeterValue(1);
        const mv = await csms.waitForCall("MeterValues");
        await settle(csms);

        expect(v.meterValues(mv.payload)).toBe(true);
        expect(updates(csms)).toHaveLength(0);
        cp.disconnect();
      } finally {
        stop();
        await csms.stop();
      }
    });

    it(`${v.version}: on, no transaction: MeterValues`, async () => {
      const csms = startMockCsms();
      const stop = answerEverythingElse(csms, []);
      try {
        const cp = await bootedChargePoint(
          csms,
          `CP347-idle-${v.version}`,
          v.version,
        );
        cp.txUpdatedMeterValues = true;

        cp.sendScheduledMeterValue(1);
        const mv = await csms.waitForCall("MeterValues");
        await settle(csms);

        expect(v.meterValues(mv.payload)).toBe(true);
        expect(callsOf(csms, "TransactionEvent")).toHaveLength(0);
        cp.disconnect();
      } finally {
        stop();
        await csms.stop();
      }
    });

    it(`${v.version}: on, during a transaction: an explicit or triggered sample stays MeterValues`, async () => {
      const csms = startMockCsms();
      const stop = answerEverythingElse(csms, []);
      try {
        const cp = await bootedChargePoint(
          csms,
          `CP347-explicit-${v.version}`,
          v.version,
        );
        cp.txUpdatedMeterValues = true;
        cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
        cp.startTransaction("TAG-347", 1);
        await csms.waitForFrame(event("Started"));

        cp.sendMeterValue(1);
        await csms.waitForCall("MeterValues");
        csms.send([
          2,
          "trigger-mv",
          "TriggerMessage",
          { requestedMessage: "MeterValues", evse: { id: 1 } },
        ]);
        await csms.waitForFrame(
          () => callsOf(csms, "MeterValues").length === 2,
        );
        await settle(csms);

        for (const mv of callsOf(csms, "MeterValues")) {
          expect(v.meterValues(mv[3])).toBe(true);
        }
        expect(
          updates(csms).filter((u) => u.triggerReason === "MeterValuePeriodic"),
        ).toHaveLength(0);
        cp.disconnect();
      } finally {
        stop();
        await csms.stop();
      }
    });

    it(`${v.version}: on, nothing to sample: sends nothing, like MeterValues`, async () => {
      const csms = startMockCsms();
      const stop = answerEverythingElse(csms, []);
      try {
        const cp = await bootedChargePoint(
          csms,
          `CP347-empty-${v.version}`,
          v.version,
        );
        cp.txUpdatedMeterValues = true;
        cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
        cp.configuration.applyChange("MeterValuesSampledData", "");
        cp.startTransaction("TAG-347", 1);
        const started = (await csms.waitForFrame(event("Started")))[3];

        cp.sendScheduledMeterValue(1);
        await settle(csms);

        expect(updates(csms)).toHaveLength(0);
        expect(callsOf(csms, "MeterValues")).toHaveLength(0);

        // A skipped sample takes no seqNo: Ended follows Started directly.
        cp.stopTransaction(1);
        const ended = (await csms.waitForFrame(event("Ended")))[3];
        expect((ended as TransactionEventRequestV201).seqNo).toBe(
          (started as TransactionEventRequestV201).seqNo + 1,
        );
        cp.disconnect();
      } finally {
        stop();
        await csms.stop();
      }
    });

    it(`${v.version}: Started and Ended register readings carry Transaction.Begin / Transaction.End`, async () => {
      const csms = startMockCsms();
      const stop = answerEverythingElse(csms, []);
      try {
        const cp = await bootedChargePoint(
          csms,
          `CP347-ctx-${v.version}`,
          v.version,
        );
        cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
        cp.startTransaction("TAG-347", 1);
        const started = (await csms.waitForFrame(event("Started")))[3];
        cp.stopTransaction(1);
        const ended = (await csms.waitForFrame(event("Ended")))[3];

        for (const [payload, context] of [
          [started, "Transaction.Begin"],
          [ended, "Transaction.End"],
        ] as const) {
          expect(v.txEvent(payload)).toBe(true);
          const samples = (
            payload as TransactionEventRequestV201
          ).meterValue!.flatMap((m) => m.sampledValue);
          expect(samples).toHaveLength(1);
          expect(samples[0]).toMatchObject({
            measurand: "Energy.Active.Import.Register",
            context,
          });
        }
        cp.disconnect();
      } finally {
        stop();
        await csms.stop();
      }
    });
  }

  it("OCPP-1.6J: on, during a transaction: still MeterValues", async () => {
    const csms = startMockCsms();
    const stop = answerEverythingElse(csms, ["StartTransaction"]);
    try {
      const cp = await bootedChargePoint(csms, "CP347-16", "OCPP-1.6J");
      cp.txUpdatedMeterValues = true;
      cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
      cp.startTransaction("TAG-347", 1);
      const start = await csms.waitForCall("StartTransaction");
      csms.replyCallResult(start.messageId, {
        transactionId: 347,
        idTagInfo: { status: "Accepted" },
      });
      await csms.waitForFrame(
        (f) =>
          callOf("StatusNotification")(f) &&
          (f[3] as { status?: string }).status === "Charging",
      );

      cp.sendScheduledMeterValue(1);
      await csms.waitForCall("MeterValues");
      expect(callsOf(csms, "TransactionEvent")).toHaveLength(0);
      cp.disconnect();
    } finally {
      stop();
      await csms.stop();
    }
  });
});
