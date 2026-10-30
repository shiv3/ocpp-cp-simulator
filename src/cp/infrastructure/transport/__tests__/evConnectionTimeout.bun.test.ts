import { describe, expect, it } from "bun:test";
import {
  isValidTransactionEventRequestV201,
  type TransactionEventRequestV201,
} from "../../../../ocpp/v201";
import { isValidTransactionEventRequestV21 } from "../../../../ocpp/v21";
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
 * #549: on OCPP 2.x, `TxCtrlr.EVConnectionTimeOut` (1.6 key
 * `ConnectionTimeOut`) ends a transaction that started without the EV
 * connecting in time: TransactionEvent(Ended), stoppedReason `Timeout`,
 * triggerReason `EVConnectTimeout` (E03.FR.05). Without a started
 * transaction the connector still goes Preparing → Finishing (§4.9 B6).
 */

const VERSIONS = [
  { version: "OCPP-2.0.1", valid: isValidTransactionEventRequestV201 },
  { version: "OCPP-2.1", valid: isValidTransactionEventRequestV21 },
] as const;

const statusOf = (status: string) => (frame: OcppFrame) =>
  frame[0] === 2 &&
  frame[2] === "StatusNotification" &&
  ((frame[3] as { status?: string }).status === status ||
    (frame[3] as { connectorStatus?: string }).connectorStatus === status);

const transactionEvents = (csms: MockCsms): TransactionEventRequestV201[] =>
  callsOf(csms, "TransactionEvent").map(
    (frame) => frame[3] as TransactionEventRequestV201,
  );

async function stationWithTimeout(
  csms: MockCsms,
  id: string,
  version: string,
): Promise<{ cp: ChargePoint; stopAnswering: () => void }> {
  const cp = await bootedChargePoint(csms, id, version);
  cp.configuration.applyChange("AuthorizeBeforeLocalStart", "false");
  cp.configuration.applyChange("ConnectionTimeOut", "1");
  const stopAnswering = answerEverythingElse(csms, []);
  return { cp, stopAnswering };
}

describe("EVConnectionTimeOut on OCPP 2.x (#549, E03.FR.05)", () => {
  for (const v of VERSIONS) {
    it(`${v.version}: a started transaction is ended with Timeout / EVConnectTimeout`, async () => {
      const csms = startMockCsms();
      const { cp, stopAnswering } = await stationWithTimeout(
        csms,
        `CP-EVCT-TX-${v.version}`,
        v.version,
      );
      try {
        await cp.startTransaction("TAG-549", 1);
        await csms.waitForFrame(
          (frame) =>
            callOf("TransactionEvent")(frame) &&
            (frame[3] as TransactionEventRequestV201).eventType === "Started",
        );
        expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Preparing);

        const ended = await csms.waitForFrame(
          (frame) =>
            callOf("TransactionEvent")(frame) &&
            (frame[3] as TransactionEventRequestV201).eventType === "Ended",
          3000,
        );
        const payload = ended[3] as TransactionEventRequestV201;
        expect(v.valid(payload)).toBe(true);
        expect(payload.triggerReason).toBe("EVConnectTimeout");
        expect(payload.transactionInfo.stoppedReason).toBe("Timeout");
        expect(cp.getConnector(1)?.hasRunningTransaction).toBe(false);
        for (const event of transactionEvents(csms)) {
          expect(v.valid(event)).toBe(true);
        }
      } finally {
        stopAnswering();
        cp.disconnect();
        await csms.stop();
      }
    });

    it(`${v.version}: without a transaction the connector goes Preparing → Finishing as before`, async () => {
      const csms = startMockCsms();
      const { cp, stopAnswering } = await stationWithTimeout(
        csms,
        `CP-EVCT-NOTX-${v.version}`,
        v.version,
      );
      try {
        cp.updateConnectorStatus(1, OCPPStatus.Preparing);
        await csms.waitForFrame(statusOf("Occupied"));
        await new Promise((resolve) => setTimeout(resolve, 1300));
        expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Finishing);
        expect(transactionEvents(csms)).toHaveLength(0);
      } finally {
        stopAnswering();
        cp.disconnect();
        await csms.stop();
      }
    });
  }
});
