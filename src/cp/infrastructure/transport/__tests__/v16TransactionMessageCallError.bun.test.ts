import { describe, expect, it } from "bun:test";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { ChargePointEvents } from "../../../domain/charge-point/ChargePointEvents";
import { OCPPStatus } from "../../../domain/types/OcppTypes";
import {
  answerTo,
  type MockCsms,
  type OcppFrame,
  startMockCsms,
} from "./mockCsms";
import {
  answerEverythingElse,
  bootedChargePoint,
  callOf,
  callsOf,
} from "./stationHarness";

/**
 * #527, OCPP 1.6 Part 2 §3.7.1: a CALLERROR answering StartTransaction.req,
 * StopTransaction.req or a MeterValues.req of a transaction is a failure to
 * process it. The station resends the same message under a new message id,
 * up to `TransactionMessageAttempts` transmissions, then discards it and
 * carries on: the transaction keeps running. (Before #527, a CALLERROR on
 * StartTransaction.req abandoned the transaction, #447.) The wait between
 * transmissions (`TransactionMessageRetryInterval` x transmissions so far)
 * is covered with fake timers in OCPPMessageHandler.transactionRetry.test.ts;
 * here it is set to 0.
 */

let sentinels = 0;

/** Wait until every frame the station wrote so far has arrived: frames go
 *  out in order, so a sentinel DataTransfer arriving proves it. */
async function drainWire(cp: ChargePoint, csms: MockCsms): Promise<void> {
  const vendorId = `sentinel-527-${++sentinels}`;
  void cp
    .sendOcppCall({ action: "DataTransfer", payload: { vendorId } })
    .catch(() => undefined);
  await csms.waitForFrame(
    (f) =>
      callOf("DataTransfer")(f) &&
      (f[3] as { vendorId?: string }).vendorId === vendorId,
  );
}

async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** The `n`-th (1-based) CALL of `action` the station sent. */
function nthCall(
  csms: MockCsms,
  action: string,
  n: number,
): Promise<OcppFrame> {
  return csms.waitForFrame(
    (f) => callOf(action)(f) && callsOf(csms, action).indexOf(f) === n - 1,
  );
}

function callError(csms: MockCsms, frame: OcppFrame, code = "InternalError") {
  csms.send([4, frame[1], code, "boom", {}]);
}

/** A booted 1.6 station that resends at once, `skip` left unanswered. */
async function station(id: string, skip: readonly string[]) {
  const csms = startMockCsms();
  const cp = await bootedChargePoint(csms, id, "OCPP-1.6J");
  cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
  cp.configuration.applyChange("TransactionMessageRetryInterval", "0");
  const stopAnswering = answerEverythingElse(csms, skip);
  const rejected: Array<ChargePointEvents["transactionMessageRejected"]> = [];
  const discarded: Array<ChargePointEvents["transactionMessageDiscarded"]> = [];
  cp.events.on("transactionMessageRejected", (e) => rejected.push(e));
  cp.events.on("transactionMessageDiscarded", (e) => discarded.push(e));
  const stops: unknown[] = [];
  cp.events.on("transactionStopped", (e) => stops.push(e));
  return {
    cp,
    csms,
    rejected,
    discarded,
    stops,
    stop: async () => {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    },
  };
}

describe("OCPP 1.6 transaction message CALLERROR (#527, §3.7.1)", () => {
  it("resends StartTransaction, then discards it with the transaction still running", async () => {
    const s = await station("CP16-527-START", ["StartTransaction"]);
    try {
      void s.cp.startTransaction("TAG-527", 1);
      for (let n = 1; n <= 3; n++) {
        callError(s.csms, await nthCall(s.csms, "StartTransaction", n));
      }
      await until(() => s.discarded.length === 1, "the discard");
      await drainWire(s.cp, s.csms);

      const starts = callsOf(s.csms, "StartTransaction");
      expect(starts).toHaveLength(3);
      expect(new Set(starts.map((f) => f[1])).size).toBe(3);
      expect(starts.map((f) => f[3])).toEqual([
        starts[0]![3],
        starts[0]![3],
        starts[0]![3],
      ]);
      expect(s.rejected.map((r) => [r.action, r.attempt])).toEqual([
        ["StartTransaction", 1],
        ["StartTransaction", 2],
        ["StartTransaction", 3],
      ]);
      expect(s.discarded).toEqual([
        {
          connectorId: 1,
          transactionId: "0",
          action: "StartTransaction",
          reason: "callError",
          errorCode: "InternalError",
          attempts: 3,
        },
      ]);
      // The transaction keeps running under its placeholder id.
      const transaction = s.cp.getConnector(1)?.transaction;
      expect(transaction?.stopTime).toBeNull();
      expect(transaction?.id).toBe(0);
      expect(s.cp.getConnector(1)?.status).toBe(OCPPStatus.Charging);
      expect(s.stops).toEqual([]);
    } finally {
      await s.stop();
    }
  });

  it("takes the transaction id of a resend the CSMS accepts", async () => {
    const s = await station("CP16-527-ACCEPT", ["StartTransaction"]);
    try {
      void s.cp.startTransaction("TAG-527", 1);
      callError(s.csms, await nthCall(s.csms, "StartTransaction", 1));
      const resend = await nthCall(s.csms, "StartTransaction", 2);
      s.csms.replyCallResult(resend[1] as string, {
        transactionId: 527,
        idTagInfo: { status: "Accepted" },
      });
      await until(
        () => s.cp.getConnector(1)?.transaction?.id === 527,
        "the accepted transaction id",
      );

      expect(s.cp.getConnector(1)?.status).toBe(OCPPStatus.Charging);
      expect(s.rejected).toHaveLength(1);
      expect(s.discarded).toEqual([]);
    } finally {
      await s.stop();
    }
  });

  it("a transaction whose StartTransaction was discarded stops with the placeholder id", async () => {
    const s = await station("CP16-527-STOP0", ["StartTransaction"]);
    try {
      s.cp.configuration.applyChange("TransactionMessageAttempts", "1");
      void s.cp.startTransaction("TAG-527", 1);
      callError(s.csms, await nthCall(s.csms, "StartTransaction", 1));
      await until(() => s.discarded.length === 1, "the discard");

      s.cp.stopTransaction(1, "Local");
      const stop = await nthCall(s.csms, "StopTransaction", 1);

      expect((stop[3] as { transactionId: number }).transactionId).toBe(0);
      expect(s.stops).toHaveLength(1);
    } finally {
      await s.stop();
    }
  });

  it("RemoteStopTransaction for the placeholder id stops a transaction whose StartTransaction was discarded", async () => {
    // Before #527 the CALLERROR detached the transaction, and this was
    // Rejected with no StopTransaction.req (#491). It now runs on under id 0.
    const s = await station("CP16-527-REMOTESTOP", ["StartTransaction"]);
    try {
      s.cp.configuration.applyChange("TransactionMessageAttempts", "1");
      void s.cp.startTransaction("TAG-527", 1);
      callError(s.csms, await nthCall(s.csms, "StartTransaction", 1));
      await until(() => s.discarded.length === 1, "the discard");

      s.csms.send([
        2,
        "remote-stop-527",
        "RemoteStopTransaction",
        { transactionId: 0 },
      ]);
      const answer = await s.csms.waitForFrame(answerTo("remote-stop-527"));
      const stop = await nthCall(s.csms, "StopTransaction", 1);
      await drainWire(s.cp, s.csms);

      expect(answer[2]).toEqual({ status: "Accepted" });
      expect((stop[3] as { transactionId: number }).transactionId).toBe(0);
      expect(callsOf(s.csms, "StopTransaction")).toHaveLength(1);
    } finally {
      await s.stop();
    }
  });

  it("resends StopTransaction, then discards it", async () => {
    const s = await station("CP16-527-STOPTX", [
      "StartTransaction",
      "StopTransaction",
    ]);
    try {
      void s.cp.startTransaction("TAG-527", 1);
      const start = await nthCall(s.csms, "StartTransaction", 1);
      s.csms.replyCallResult(start[1] as string, {
        transactionId: 77,
        idTagInfo: { status: "Accepted" },
      });
      await until(
        () => s.cp.getConnector(1)?.transaction?.id === 77,
        "the accepted transaction id",
      );
      s.cp.stopTransaction(1, "Local");
      for (let n = 1; n <= 3; n++) {
        callError(s.csms, await nthCall(s.csms, "StopTransaction", n));
      }
      await until(() => s.discarded.length === 1, "the discard");
      await drainWire(s.cp, s.csms);

      const stops = callsOf(s.csms, "StopTransaction");
      expect(stops).toHaveLength(3);
      expect(stops.map((f) => f[3])).toEqual([
        stops[0]![3],
        stops[0]![3],
        stops[0]![3],
      ]);
      expect(s.discarded).toMatchObject([
        { action: "StopTransaction", transactionId: "77", attempts: 3 },
      ]);
      expect(s.discarded[0]!.eventType).toBeUndefined();
    } finally {
      await s.stop();
    }
  });

  it("resends a MeterValues.req of a transaction, not one without a transaction id", async () => {
    const s = await station("CP16-527-METER", [
      "StartTransaction",
      "MeterValues",
    ]);
    try {
      // No transaction: a CALLERROR is the end of it.
      s.cp.sendMeterValue(1);
      callError(s.csms, await nthCall(s.csms, "MeterValues", 1));
      await drainWire(s.cp, s.csms);
      expect(callsOf(s.csms, "MeterValues")).toHaveLength(1);
      expect(s.rejected).toEqual([]);

      void s.cp.startTransaction("TAG-527", 1);
      const start = await nthCall(s.csms, "StartTransaction", 1);
      s.csms.replyCallResult(start[1] as string, {
        transactionId: 78,
        idTagInfo: { status: "Accepted" },
      });
      await until(
        () => s.cp.getConnector(1)?.transaction?.id === 78,
        "the accepted transaction id",
      );
      const before = callsOf(s.csms, "MeterValues").length;
      s.cp.sendMeterValue(1);
      const sample = await nthCall(s.csms, "MeterValues", before + 1);
      callError(s.csms, sample);
      const resend = await nthCall(s.csms, "MeterValues", before + 2);
      s.csms.replyCallResult(resend[1] as string, {});

      expect(resend[3]).toEqual(sample[3]);
      expect(s.rejected).toEqual([
        {
          connectorId: 1,
          transactionId: "78",
          action: "MeterValues",
          reason: "callError",
          errorCode: "InternalError",
          attempt: 1,
        },
      ]);
      expect(s.discarded).toEqual([]);
    } finally {
      await s.stop();
    }
  });
});

describe("OCPP 1.6 stopTransaction on a closed transaction (#491)", () => {
  it("stopTransaction leaves a transaction that is already closed alone", async () => {
    // A closed transaction can still be attached: one a daemon persisted
    // before #491 comes back from `connector_runtime` that way. Stopping
    // it again would put the same StopTransaction.req on the wire twice.
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP16-491-CLOSED", "OCPP-1.6J");
    cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
    const stopAnswering = answerEverythingElse(csms, ["StartTransaction"]);
    try {
      void cp.startTransaction("TAG-491", 1);
      const start = await csms.waitForCall("StartTransaction");
      csms.replyCallResult(start.messageId, {
        transactionId: 491,
        idTagInfo: { status: "Accepted" },
      });
      await until(
        () => cp.getConnector(1)?.transaction?.id === 491,
        "the accepted transaction id",
      );
      cp.cleanTransaction(1);

      cp.stopTransaction(1, "Local");
      await drainWire(cp, csms);

      expect(callsOf(csms, "StopTransaction")).toEqual([]);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });
});
