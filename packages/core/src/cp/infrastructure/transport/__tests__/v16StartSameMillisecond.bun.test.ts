import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { startMockCsms } from "./mockCsms";
import { answerEverythingElse, bootedChargePoint } from "./stationHarness";

/**
 * #586: a StartTransaction.req is matched to its transaction by `idTag` and
 * `timestamp`. A stop then a start by the same tag in the same millisecond
 * must not give the second transaction the first one's pair, or a late answer
 * to the first request would apply to it.
 */
describe("OCPP 1.6 StartTransaction in the same millisecond (#586)", () => {
  afterEach(() => setSystemTime());

  /** A stop then a second start in the same millisecond, the first
   *  StartTransaction.req still unanswered; returns its message id. */
  async function secondStartWhileFirstUnanswered() {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP16-586", "OCPP-1.6J");
    cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
    const stopAnswering = answerEverythingElse(csms, ["StartTransaction"]);
    setSystemTime(new Date("2026-11-09T10:00:00.000Z"));
    void cp.startTransaction("TAG-586", 1);
    const first = await csms.waitForCall("StartTransaction");
    const t1 = cp.getConnector(1)!.transaction!.startTime;
    await cp.stopTransaction(1);
    await cp.startTransaction("TAG-586", 1);
    const second = cp.getConnector(1)!.transaction!;
    return { csms, cp, stopAnswering, first, t1, second };
  }

  it("gives the second start a later timestamp, and only on a collision", async () => {
    const { csms, cp, stopAnswering, t1, second } =
      await secondStartWhileFirstUnanswered();
    try {
      // Same tag, same millisecond on the clock: the pair that matches a
      // StartTransaction answer to its transaction must still differ.
      expect(second.startTime.getTime()).toBe(t1.getTime() + 1);

      // A clock stepped back is not a collision: the start keeps the clock.
      await cp.stopTransaction(1);
      setSystemTime(new Date("2026-11-09T09:59:00.000Z"));
      await cp.startTransaction("TAG-586", 1);
      expect(cp.getConnector(1)!.transaction!.startTime.toISOString()).toBe(
        "2026-11-09T09:59:00.000Z",
      );
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("does not apply a late conf of the first start to the second transaction", async () => {
    const { csms, cp, stopAnswering, first, second } =
      await secondStartWhileFirstUnanswered();
    try {
      expect(second.id).toBe(0);
      csms.replyCallResult(first.messageId, {
        transactionId: 1,
        idTagInfo: { status: "Accepted" },
      });
      await Bun.sleep(200);
      const running = cp.getConnector(1)!.transaction!;
      expect(running.id).toBe(0);
      expect(running.startUnanswered).toBe(true);
      expect(running.startCallError).toBeUndefined();
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });

  it("does not flag the second transaction for a late CALLERROR of the first start", async () => {
    const { csms, cp, stopAnswering, first, second } =
      await secondStartWhileFirstUnanswered();
    try {
      expect(second.id).toBe(0);
      csms.send([4, first.messageId, "InternalError", "", {}]);
      await Bun.sleep(300);
      const running = cp.getConnector(1)!.transaction!;
      expect(running.id).toBe(0);
      expect(running.startCallError).toBeUndefined();
      // The first request's own retry holds the queue: nothing was sent
      // for the second transaction on the strength of that CALLERROR.
      expect(running.startUnanswered).toBe(true);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });
});
