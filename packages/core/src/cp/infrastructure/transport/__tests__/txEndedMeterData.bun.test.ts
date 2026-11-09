import { describe, expect, it } from "bun:test";
import { isValidTransactionEventRequestV201 } from "@ocpp-cp-simulator/ocpp/v201/index";
import type {
  StopTransactionRequestV16,
  TransactionEventRequestV201,
} from "@ocpp-cp-simulator/ocpp/index";
import { startMockCsms, type MockCsms, type OcppFrame } from "./mockCsms";
import {
  answerEverythingElse,
  bootedChargePoint,
  callOf,
  callsOf,
} from "./stationHarness";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { MainMeter } from "../../../domain/charge-point/MainMeter";
import { TX_ENDED_SAMPLES_MAX } from "../../../domain/connector/Transaction";

/**
 * #607: transaction-end meter data. 1.6 §3.16.1 / §3.16.2 put the
 * `StopTxnSampledData` / `StopTxnAlignedData` samples in
 * StopTransaction.transactionData; 2.x puts `TxStartedMeasurands` in
 * TransactionEvent(Started) and the `TxEnded*` samples in
 * TransactionEvent(Ended). With the default settings nothing changes.
 */

const POWER = "Power.Active.Import";
const REGISTER = "Energy.Active.Import.Register";

const ended = (f: OcppFrame) =>
  callOf("TransactionEvent")(f) &&
  (f[3] as { eventType?: string }).eventType === "Ended";

/** Boot a 1.6 station, start a transaction and wait until it is Charging. */
async function charging16(csms: MockCsms, id: string): Promise<ChargePoint> {
  const cp = await bootedChargePoint(csms, id, "OCPP-1.6J");
  cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
  return cp;
}

async function startAndCharge16(csms: MockCsms, cp: ChargePoint) {
  cp.startTransaction("TAG-607", 1);
  const start = await csms.waitForCall("StartTransaction");
  csms.replyCallResult(start.messageId, {
    transactionId: 607,
    idTagInfo: { status: "Accepted" },
  });
  await csms.waitForFrame(
    (f) =>
      callOf("StatusNotification")(f) &&
      (f[3] as { status?: string }).status === "Charging",
  );
}

const stopTx16 = (csms: MockCsms) =>
  callsOf(csms, "StopTransaction")[0][3] as StopTransactionRequestV16;

describe("OCPP 1.6 transaction-end meter data (#607)", () => {
  it("default settings: StopTransaction carries no transactionData", async () => {
    const csms = startMockCsms();
    const stop = answerEverythingElse(csms, ["StartTransaction"]);
    try {
      const cp = await charging16(csms, "CP607-default");
      await startAndCharge16(csms, cp);
      cp.sendScheduledMeterValue(1);
      cp.stopTransaction(1);
      await csms.waitForCall("StopTransaction");
      expect(stopTx16(csms).transactionData).toBeUndefined();
      expect(cp.getConnector(1)?.transaction?.txEndedSamples).toBeUndefined();
      cp.disconnect();
    } finally {
      stop();
      await csms.stop();
    }
  });

  it("StopTxnSampledData: Begin, tick and End samples, End power read at the stop instant", async () => {
    const csms = startMockCsms();
    const stop = answerEverythingElse(csms, ["StartTransaction"]);
    try {
      const cp = await charging16(csms, "CP607-sampled");
      cp.configuration.applyChange(
        "StopTxnSampledData",
        `${REGISTER},${POWER}`,
      );
      await startAndCharge16(csms, cp);
      cp.setMeterValue(1, 2500);
      cp.sendScheduledMeterValue(1);
      cp.stopTransaction(1);
      await csms.waitForCall("StopTransaction");

      const data = stopTx16(csms).transactionData!;
      const contexts = data.map((d) => d.sampledValue[0].context);
      expect(contexts).toEqual([
        "Transaction.Begin",
        "Sample.Periodic",
        "Transaction.End",
      ]);
      const power = (i: number) =>
        data[i].sampledValue.find((s) => s.measurand === POWER)!.value;
      // The Begin sample precedes Charging: nothing flows yet.
      expect(power(0)).toBe("0");
      // The stop falls on the tick: End describes the same instant as the
      // periodic sample, not the Finishing connector (power 0).
      expect(Number(power(1))).toBeGreaterThan(0);
      expect(power(2)).toBe(power(1));
      expect(
        data[2].sampledValue.find((s) => s.measurand === REGISTER)!.value,
      ).toBe("2500");
      expect(stopTx16(csms).meterStop).toBe(2500);
      cp.disconnect();
    } finally {
      stop();
      await csms.stop();
    }
  });

  // #846: transactionData is spelled for the OCPP-J 1.6 wire like MeterValues.
  it("Temperature in transactionData carries the errata spelling Celcius", async () => {
    const csms = startMockCsms();
    const stop = answerEverythingElse(csms, ["StartTransaction"]);
    try {
      const cp = await charging16(csms, "CP846-celcius");
      cp.configuration.applyChange(
        "StopTxnSampledData",
        `${REGISTER},Temperature`,
      );
      await startAndCharge16(csms, cp);
      cp.sendScheduledMeterValue(1);
      cp.stopTransaction(1);
      await csms.waitForCall("StopTransaction");

      const units = stopTx16(csms)
        .transactionData!.flatMap((d) => d.sampledValue)
        .filter((s) => s.measurand === "Temperature")
        .map((s) => s.unit);
      expect(units.length).toBeGreaterThan(0);
      expect(new Set(units)).toEqual(new Set(["Celcius"]));
      cp.disconnect();
    } finally {
      stop();
      await csms.stop();
    }
  });

  it("StopTxnAlignedData: one Sample.Clock entry per boundary, at the boundary instant", async () => {
    const csms = startMockCsms();
    const stop = answerEverythingElse(csms, ["StartTransaction"]);
    try {
      const cp = await charging16(csms, "CP607-aligned");
      cp.configuration.applyChange("StopTxnAlignedData", REGISTER);
      await startAndCharge16(csms, cp);
      const boundary = Date.UTC(2030, 0, 1, 0, 15, 0);
      (
        cp as unknown as { emitClockAlignedSamples(ms: number): void }
      ).emitClockAlignedSamples(boundary);
      cp.stopTransaction(1);
      await csms.waitForCall("StopTransaction");

      const data = stopTx16(csms).transactionData!;
      expect(data).toHaveLength(1);
      expect(data[0].timestamp).toBe(new Date(boundary).toISOString());
      expect(data[0].sampledValue[0]).toMatchObject({
        context: "Sample.Clock",
        measurand: REGISTER,
      });
      // MeterValuesAlignedData is empty: no MeterValues went out for it.
      expect(callsOf(csms, "MeterValues")).toHaveLength(0);
      cp.disconnect();
    } finally {
      stop();
      await csms.stop();
    }
  });

  it("the history is bounded", async () => {
    const csms = startMockCsms();
    const stop = answerEverythingElse(csms, ["StartTransaction"]);
    try {
      const cp = await charging16(csms, "CP607-bound");
      cp.configuration.applyChange("StopTxnAlignedData", REGISTER);
      await startAndCharge16(csms, cp);
      const emit = (ms: number) =>
        (
          cp as unknown as { emitClockAlignedSamples(ms: number): void }
        ).emitClockAlignedSamples(ms);
      for (let i = 0; i < TX_ENDED_SAMPLES_MAX + 5; i++)
        emit(1_900_000_000_000 + i * 1000);
      const history = cp.getConnector(1)!.transaction!.txEndedSamples!;
      expect(history).toHaveLength(TX_ENDED_SAMPLES_MAX);
      // The oldest are the ones dropped.
      expect(history[0].timestamp).toBe(
        new Date(1_900_000_000_000 + 5 * 1000).toISOString(),
      );
      // It survives the persisted form (transaction_json).
      const again = JSON.parse(JSON.stringify(cp.getConnector(1)!.transaction));
      expect(again.txEndedSamples).toHaveLength(TX_ENDED_SAMPLES_MAX);
      cp.disconnect();
    } finally {
      stop();
      await csms.stop();
    }
  });
});

describe("OCPP 2.x transaction-end meter data (#607)", () => {
  async function start2(csms: MockCsms, id: string): Promise<ChargePoint> {
    const cp = await bootedChargePoint(csms, id, "OCPP-2.0.1");
    cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
    return cp;
  }
  const events = (csms: MockCsms, type: string) =>
    csms.received
      .filter(
        (f) =>
          callOf("TransactionEvent")(f) &&
          (f[3] as { eventType?: string }).eventType === type,
      )
      .map((f) => f[3] as TransactionEventRequestV201);

  it("default settings: Started and Ended carry the register alone", async () => {
    const csms = startMockCsms();
    const stop = answerEverythingElse(csms, []);
    try {
      const cp = await start2(csms, "CP607-v2-default");
      cp.startTransaction("TAG-607", 1);
      await csms.waitForFrame((f) => callOf("TransactionEvent")(f));
      cp.sendScheduledMeterValue(1);
      cp.stopTransaction(1);
      await csms.waitForFrame(ended);
      const [start] = events(csms, "Started");
      const [end] = events(csms, "Ended");
      expect(start.meterValue).toHaveLength(1);
      expect(start.meterValue![0].sampledValue).toHaveLength(1);
      expect(end.meterValue).toHaveLength(1);
      expect(end.meterValue![0].sampledValue).toHaveLength(1);
      cp.disconnect();
    } finally {
      stop();
      await csms.stop();
    }
  });

  it("TxStartedMeasurands / TxEndedMeasurands / TxEndedInterval", async () => {
    const csms = startMockCsms();
    const stop = answerEverythingElse(csms, []);
    try {
      const cp = await start2(csms, "CP607-v2-on");
      cp.configuration.applyChange(
        "TxStartedMeasurands",
        `${REGISTER},Voltage`,
      );
      cp.configuration.applyChange(
        "StopTxnSampledData",
        `${REGISTER},${POWER}`,
      );
      cp.configuration.applyChange("TxEndedInterval", "60");
      cp.startTransaction("TAG-607", 1);
      await csms.waitForFrame((f) => callOf("TransactionEvent")(f));
      // A tick before TxEndedInterval has passed records nothing.
      cp.sendScheduledMeterValue(1);
      // Only the reading taken at the start is in the history yet.
      expect(
        cp
          .getConnector(1)!
          .transaction!.txEndedSamples!.map((e) => e.sampledValue[0].context),
      ).toEqual(["Transaction.Begin"]);
      cp.stopTransaction(1);
      await csms.waitForFrame(ended);

      const [start] = events(csms, "Started");
      const startSamples = start.meterValue![0].sampledValue;
      expect(startSamples.map((s) => s.measurand ?? REGISTER)).toEqual([
        REGISTER,
        "Voltage",
      ]);
      expect(startSamples.every((s) => s.context === "Transaction.Begin")).toBe(
        true,
      );
      const [end] = events(csms, "Ended");
      expect(isValidTransactionEventRequestV201(end)).toBe(true);
      const last = end.meterValue!.at(-1)!.sampledValue;
      expect(last.map((s) => s.measurand ?? REGISTER)).toEqual([
        REGISTER,
        POWER,
      ]);
      expect(last.every((s) => s.context === "Transaction.End")).toBe(true);
      cp.disconnect();
    } finally {
      stop();
      await csms.stop();
    }
  });

  it("aligned TxEnded samples ride Ended; SendDuringIdle silences MeterValues in a transaction", async () => {
    const csms = startMockCsms();
    const stop = answerEverythingElse(csms, []);
    try {
      const cp = await start2(csms, "CP607-v2-aligned");
      cp.configuration.applyChange("StopTxnAlignedData", REGISTER);
      cp.configuration.applyChange("MeterValuesAlignedData", REGISTER);
      cp.configuration.applyChange("AlignedDataSendDuringIdle", "true");
      cp.startTransaction("TAG-607", 1);
      await csms.waitForFrame((f) => callOf("TransactionEvent")(f));
      const emit = (
        cp as unknown as { emitClockAlignedSamples(ms: number): void }
      ).emitClockAlignedSamples.bind(cp);
      // Aligned history is the 2.x grid's job; the Interval grid sends
      // nothing for a connector in a transaction.
      emit(Date.UTC(2030, 0, 1, 0, 15));
      cp.stopTransaction(1);
      await csms.waitForFrame(ended);
      expect(
        events(csms, "Updated").filter(
          (u) => u.triggerReason === "MeterValueClock",
        ),
      ).toHaveLength(0);
      expect(callsOf(csms, "MeterValues")).toHaveLength(0);

      // Idle connector: the clock-aligned MeterValues go out as before.
      emit(Date.UTC(2030, 0, 1, 0, 30));
      await csms.waitForCall("MeterValues");
      cp.disconnect();
    } finally {
      stop();
      await csms.stop();
    }
  });

  it("SendDuringIdle is station-wide: a transaction on one EVSE silences every EVSE and the main meter (J01.FR.20)", async () => {
    const csms = startMockCsms();
    const stop = answerEverythingElse(csms, []);
    try {
      const cp = await bootedChargePoint(
        csms,
        "CP607-v2-idle-all",
        "OCPP-2.0.1",
        {
          connectors: 2,
        },
      );
      cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
      cp.configuration.applyChange("MeterValuesAlignedData", REGISTER);
      cp.configuration.applyChange("AlignedDataSendDuringIdle", "true");
      (cp as unknown as { _mainMeter: MainMeter })._mainMeter = new MainMeter(
        {},
        () => cp.connectors,
        { now: () => Date.now() } as never,
      );
      cp.startTransaction("TAG-607", 1);
      await csms.waitForFrame((f) => callOf("TransactionEvent")(f));
      const emit = (
        cp as unknown as { emitClockAlignedSamples(ms: number): void }
      ).emitClockAlignedSamples.bind(cp);
      emit(Date.UTC(2030, 0, 1, 0, 15));
      await new Promise((resolve) => setTimeout(resolve, 300));
      // EVSE 2 is idle but the station has a transaction; so is the main meter.
      expect(callsOf(csms, "MeterValues")).toHaveLength(0);

      cp.stopTransaction(1);
      await csms.waitForFrame(ended);
      emit(Date.UTC(2030, 0, 1, 0, 30));
      await csms.waitForFrame(
        (f) =>
          callOf("MeterValues")(f) &&
          (f[3] as { evseId?: number }).evseId === 0,
      );
      // Idle again: both EVSEs and the main meter report.
      expect(callsOf(csms, "MeterValues").length).toBeGreaterThanOrEqual(3);
      cp.disconnect();
    } finally {
      stop();
      await csms.stop();
    }
  });

  it("TxEndedInterval = 0: Ended carries the start and the end reading (E06.FR.11)", async () => {
    const csms = startMockCsms();
    const stop = answerEverythingElse(csms, []);
    try {
      const cp = await start2(csms, "CP607-v2-begin-end");
      cp.configuration.applyChange(
        "StopTxnSampledData",
        `${REGISTER},${POWER}`,
      );
      cp.startTransaction("TAG-607", 1);
      await csms.waitForFrame((f) => callOf("TransactionEvent")(f));
      cp.stopTransaction(1);
      await csms.waitForFrame(ended);
      const [end] = events(csms, "Ended");
      expect(isValidTransactionEventRequestV201(end)).toBe(true);
      expect(end.meterValue!.map((m) => m.sampledValue[0].context)).toEqual([
        "Transaction.Begin",
        "Transaction.End",
      ]);
      cp.disconnect();
    } finally {
      stop();
      await csms.stop();
    }
  });

  it("a measurand outside MeasurandEnumType never reaches the history or Ended (#714)", async () => {
    const csms = startMockCsms();
    const stop = answerEverythingElse(csms, []);
    try {
      const cp = await start2(csms, "CP607-v2-enum");
      // A persisted or scenario-set list can still carry a 1.6 measurand.
      cp.configuration.applyChange(
        "StopTxnSampledData",
        `${REGISTER},Temperature`,
      );
      cp.startTransaction("TAG-607", 1);
      await csms.waitForFrame((f) => callOf("TransactionEvent")(f));
      cp.stopTransaction(1);
      await csms.waitForFrame(ended);
      const [end] = events(csms, "Ended");
      expect(isValidTransactionEventRequestV201(end)).toBe(true);
      expect(
        end.meterValue!.flatMap((m) => m.sampledValue.map((s) => s.measurand)),
      ).not.toContain("Temperature");
      cp.disconnect();
    } finally {
      stop();
      await csms.stop();
    }
  });

  it("history entries reach Ended in order, before the End reading", async () => {
    const csms = startMockCsms();
    const stop = answerEverythingElse(csms, []);
    try {
      const cp = await start2(csms, "CP607-v2-history");
      cp.configuration.applyChange("StopTxnSampledData", REGISTER);
      cp.configuration.applyChange("StopTxnAlignedData", REGISTER);
      cp.configuration.applyChange("TxEndedInterval", "60");
      cp.startTransaction("TAG-607", 1);
      await csms.waitForFrame((f) => callOf("TransactionEvent")(f));
      // Two minutes into the transaction the 60 s interval has passed.
      cp.getConnector(1)!.transaction!.startTime = new Date(
        Date.now() - 120_000,
      );
      cp.sendScheduledMeterValue(1);
      // An immediate second tick is inside the interval: no second entry.
      cp.sendScheduledMeterValue(1);
      (
        cp as unknown as {
          recordAlignedTxEndedSamples(m: string[], ms: number): void;
        }
      ).recordAlignedTxEndedSamples([REGISTER], Date.now() + 1000);
      cp.stopTransaction(1);
      await csms.waitForFrame(ended);
      const [end] = events(csms, "Ended");
      expect(isValidTransactionEventRequestV201(end)).toBe(true);
      expect(end.meterValue!.map((m) => m.sampledValue[0].context)).toEqual([
        "Transaction.Begin",
        "Sample.Periodic",
        "Sample.Clock",
        "Transaction.End",
      ]);
      cp.disconnect();
    } finally {
      stop();
      await csms.stop();
    }
  });
});
