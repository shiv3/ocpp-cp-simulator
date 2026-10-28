import { describe, expect, it } from "bun:test";
import type { ChargePointEvents } from "../../../domain/charge-point/ChargePointEvents";
import { OCPPStatus } from "../../../domain/types/OcppTypes";
import { startMockCsms } from "./mockCsms";
import { answerEverythingElse, bootedChargePoint } from "./stationHarness";

/**
 * #447: a CALLERROR answering StartTransaction.req means the transaction
 * never started on the CSMS side. The station closes it (and goes back to
 * Available, as before), and now says so with `transactionStartFailed`:
 * no StopTransaction.req follows, so no `transactionStopped` either.
 */
describe("OCPP 1.6 StartTransaction CALLERROR (#447)", () => {
  it("emits transactionStartFailed before closing the transaction", async () => {
    const csms = startMockCsms();
    const cp = await bootedChargePoint(csms, "CP16-CALLERROR", "OCPP-1.6J");
    cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
    const stopAnswering = answerEverythingElse(csms, ["StartTransaction"]);
    const failures: Array<{
      event: ChargePointEvents["transactionStartFailed"];
      hadTransaction: boolean;
    }> = [];
    cp.events.on("transactionStartFailed", (event) =>
      failures.push({
        event,
        hadTransaction: cp.getConnector(1)?.transaction != null,
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
          hadTransaction: true,
        },
      ]);
      expect(stops).toEqual([]);
      // cleanTransaction stamps the stop; the object stays until the next start.
      expect(cp.getConnector(1)?.transaction?.stopTime).not.toBeNull();
      expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Available);
    } finally {
      stopAnswering();
      cp.disconnect();
      await csms.stop();
    }
  });
});
