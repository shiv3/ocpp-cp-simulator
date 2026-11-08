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

  it("gives the second start a later timestamp", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP16-586", "OCPP-1.6J");
    cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
    const stopAnswering = answerEverythingElse(csms, ["StartTransaction"]);
    try {
      setSystemTime(new Date("2026-11-09T10:00:00.000Z"));
      void cp.startTransaction("TAG-586", 1);
      await csms.waitForCall("StartTransaction");
      const t1 = cp.getConnector(1)!.transaction!.startTime;
      await cp.stopTransaction(1);
      await cp.startTransaction("TAG-586", 1);
      const second = cp.getConnector(1)!.transaction!;
      // Same tag, same millisecond on the clock: the pair that matches a
      // StartTransaction answer to its transaction must still differ.
      expect(second.startTime.getTime()).toBe(t1.getTime() + 1);
      expect(
        second.startTime.toISOString() === t1.toISOString() &&
          second.tagId === "TAG-586",
      ).toBe(false);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });
});
