import { describe, expect, it } from "bun:test";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { ChargePointEvents } from "../../../domain/charge-point/ChargePointEvents";
import { OCPPStatus } from "../../../domain/types/OcppTypes";
import { answerTo, type MockCsms, startMockCsms } from "./mockCsms";
import {
  answerEverythingElse,
  bootedChargePoint,
  callOf,
  callsOf,
} from "./stationHarness";

/**
 * #447: a CALLERROR answering StartTransaction.req means the transaction
 * never started on the CSMS side. The station closes it (and goes back to
 * Available, as before), and now says so with `transactionStartFailed`:
 * no StopTransaction.req follows, so no `transactionStopped` either.
 */
describe("OCPP 1.6 StartTransaction CALLERROR (#447)", () => {
  it("emits transactionStartFailed once the transaction is closed", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP16-CALLERROR", "OCPP-1.6J");
    cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
    const stopAnswering = answerEverythingElse(csms, ["StartTransaction"]);
    const failures: Array<{
      event: ChargePointEvents["transactionStartFailed"];
      closed: boolean;
    }> = [];
    cp.events.on("transactionStartFailed", (event) =>
      failures.push({
        event,
        // Closed, and still on the connector while listeners run (#491
        // detaches it afterwards): its stop time is readable.
        closed: cp.getConnector(1)?.transaction?.stopTime instanceof Date,
      }),
    );
    const stops: unknown[] = [];
    cp.events.on("transactionStopped", (e) => stops.push(e));
    try {
      void cp.startTransaction("TAG-16", 1);
      const start = await csms.waitForCall("StartTransaction");
      csms.send([4, start.messageId, "InternalError", "boom", {}]);

      const deadline = Date.now() + 2_000;
      while (failures.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(failures).toEqual([
        {
          event: { connectorId: 1, errorCode: "InternalError" },
          closed: true,
        },
      ]);
      expect(stops).toEqual([]);
      expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Available);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });
});

/**
 * #491: the transaction a CALLERROR closed is not left on the connector, so
 * the stop paths that ask "is there a transaction?" — Reset, UnlockConnector —
 * find none and send no StopTransaction.req (it used to go out with the `0`
 * placeholder id, for a transaction the CSMS never accepted).
 */
describe("OCPP 1.6 stop paths after a StartTransaction CALLERROR (#491)", () => {
  let sentinels = 0;

  /** Wait until every frame the station wrote so far has arrived: frames go
   *  out in order, so a sentinel DataTransfer arriving proves it. */
  async function drainWire(cp: ChargePoint, csms: MockCsms): Promise<void> {
    const vendorId = `sentinel-491-${++sentinels}`;
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
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** A booted 1.6 station whose first StartTransaction.req was answered with
   *  a CALLERROR. */
  async function failedStart(id: string): Promise<{
    cp: ChargePoint;
    csms: MockCsms;
    stop: () => Promise<void>;
  }> {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, id, "OCPP-1.6J");
    cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
    const stopAnswering = answerEverythingElse(csms, ["StartTransaction"]);
    const failed = new Promise<void>((resolve) =>
      cp.events.on("transactionStartFailed", () => resolve()),
    );
    void cp.startTransaction("TAG-491", 1);
    const start = await csms.waitForCall("StartTransaction");
    csms.send([4, start.messageId, "InternalError", "boom", {}]);
    await failed;
    return {
      cp,
      csms,
      stop: async () => {
        stopAnswering();
        cp.disconnect();
        await csms.stop();
      },
    };
  }

  it("detaches the failed transaction from the connector", async () => {
    const s = await failedStart("CP16-491-DETACH");
    try {
      expect(s.cp.getConnector(1)?.transaction).toBeNull();
      expect(s.cp.getConnector(1)?.status).toBe(OCPPStatus.Available);
    } finally {
      await s.stop();
    }
  });

  it("UnlockConnector sends no StopTransaction.req", async () => {
    const s = await failedStart("CP16-491-UNLOCK");
    try {
      s.csms.send([2, "unlock-491", "UnlockConnector", { connectorId: 1 }]);
      await s.csms.waitForFrame(answerTo("unlock-491"));
      await drainWire(s.cp, s.csms);

      expect(callsOf(s.csms, "StopTransaction")).toEqual([]);
    } finally {
      await s.stop();
    }
  });

  it("a Soft Reset sends no StopTransaction.req", async () => {
    const s = await failedStart("CP16-491-SOFT");
    try {
      s.csms.send([2, "reset-491-soft", "Reset", { type: "Soft" }]);
      // The reboot's BootNotification is the sentinel: on 1.6 a
      // StopTransaction.req written before it would have gone out first.
      await until(
        () => callsOf(s.csms, "BootNotification").length === 2,
        "the post-reset BootNotification",
      );

      expect(callsOf(s.csms, "StopTransaction")).toEqual([]);
    } finally {
      await s.stop();
    }
  });

  it("RemoteStopTransaction for the placeholder id is Rejected, with no StopTransaction.req", async () => {
    const s = await failedStart("CP16-491-REMOTESTOP");
    try {
      s.csms.send([
        2,
        "remote-stop-491",
        "RemoteStopTransaction",
        { transactionId: 0 },
      ]);
      const answer = await s.csms.waitForFrame(answerTo("remote-stop-491"));
      await drainWire(s.cp, s.csms);

      expect(answer[2]).toEqual({ status: "Rejected" });
      expect(callsOf(s.csms, "StopTransaction")).toEqual([]);
    } finally {
      await s.stop();
    }
  });

  it("ChangeAvailability applies at once instead of waiting on the failed start", async () => {
    const s = await failedStart("CP16-491-AVAIL");
    try {
      s.csms.send([
        2,
        "avail-491",
        "ChangeAvailability",
        { connectorId: 1, type: "Inoperative" },
      ]);
      const answer = await s.csms.waitForFrame(answerTo("avail-491"));

      expect(answer[2]).toEqual({ status: "Accepted" });
      expect(s.cp.getConnector(1)?.availability).toBe("Inoperative");
    } finally {
      await s.stop();
    }
  });

  it("stopTransaction leaves a transaction that is already closed alone", async () => {
    // A closed transaction can still be attached: one a daemon persisted
    // before this fix comes back from `connector_runtime` that way. Stopping
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

  it("a Hard Reset sends no StopTransaction.req, even after the reboot", async () => {
    const s = await failedStart("CP16-491-HARD");
    try {
      s.csms.send([2, "reset-491-hard", "Reset", { type: "Hard" }]);
      await until(
        () => callsOf(s.csms, "BootNotification").length === 2,
        "the post-reset BootNotification",
      );
      const reboot = callsOf(s.csms, "BootNotification")[1]!;
      const statusesBefore = callsOf(s.csms, "StatusNotification").length;
      s.csms.replyCallResult(reboot[1] as string, {
        status: "Accepted",
        currentTime: "2026-10-29T00:00:00.000Z",
        interval: 300,
      });
      // A StopTransaction.req queued across the reconnect would be replayed
      // once the boot is accepted: wait for the post-boot fan-out, then
      // drain everything the station wrote after it.
      await until(
        () => callsOf(s.csms, "StatusNotification").length > statusesBefore,
        "the post-reboot StatusNotification",
      );
      await drainWire(s.cp, s.csms);

      expect(callsOf(s.csms, "StopTransaction")).toEqual([]);
    } finally {
      await s.stop();
    }
  });
});
