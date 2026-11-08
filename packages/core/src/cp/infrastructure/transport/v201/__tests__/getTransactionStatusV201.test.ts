import { describe, expect, it } from "vitest";
import { ChargePoint } from "../../../../domain/charge-point/ChargePoint";
import { DefaultBootNotification } from "../../../../domain/types/OcppTypes";
import { Logger } from "../../../../shared/Logger";
import type { V201InboundContext } from "../inboundRegistryV201";
import { handleGetTransactionStatusV201 } from "../transactionControlV201";

function context(chargePoint: ChargePoint): V201InboundContext {
  return { chargePoint, logger: new Logger(), sendCall: () => undefined };
}

/**
 * E14 (2.0.1 Part 2): `ongoingIndicator` answers for a transaction id only
 * (FR.01-03); without an id the response does not carry it (FR.06).
 */
describe.each(["OCPP-2.0.1", "OCPP-2.1"])(
  "%s GetTransactionStatus ongoingIndicator (E14)",
  (version) => {
    function stationWithTransaction(stopped: boolean) {
      const cp = new ChargePoint(
        "test-cp-700",
        DefaultBootNotification,
        1,
        "ws://localhost:8080",
        null,
        null,
        null,
        {},
        [],
        version,
        {},
      );
      const connector = cp.getConnector(1)!;
      connector.beginTransaction({
        id: 0,
        connectorId: 1,
        tagId: "TAG",
        meterStart: 0,
        meterStop: null,
        startTime: new Date("2026-11-08T00:00:00.000Z"),
        stopTime: null,
        meterSent: false,
        cpTransactionId: "tx-700",
      });
      if (stopped) {
        connector.patchTransaction({
          stopTime: new Date("2026-11-08T00:05:00.000Z"),
        });
      }
      return cp;
    }

    it("omits ongoingIndicator without a transactionId, even with a transaction running (E14.FR.06)", () => {
      const { response } = handleGetTransactionStatusV201(
        {},
        context(stationWithTransaction(false)),
      );
      expect(response).toEqual({ messagesInQueue: false });
      expect("ongoingIndicator" in (response as object)).toBe(false);
    });

    it("is true for a running transaction (E14.FR.02)", () => {
      const { response } = handleGetTransactionStatusV201(
        { transactionId: "tx-700" },
        context(stationWithTransaction(false)),
      );
      expect(response).toEqual({
        ongoingIndicator: true,
        messagesInQueue: false,
      });
    });

    it("is false for a stopped transaction still attached to its connector (E14.FR.03)", () => {
      const { response } = handleGetTransactionStatusV201(
        { transactionId: "tx-700" },
        context(stationWithTransaction(true)),
      );
      expect(response).toEqual({
        ongoingIndicator: false,
        messagesInQueue: false,
      });
    });

    it("is false for an unknown transactionId (E14.FR.01)", () => {
      const { response } = handleGetTransactionStatusV201(
        { transactionId: "nope" },
        context(stationWithTransaction(false)),
      );
      expect(response).toEqual({
        ongoingIndicator: false,
        messagesInQueue: false,
      });
    });
  },
);
