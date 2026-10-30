import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OCPPStatus } from "../../types/OcppTypes";
import { OCPP_2_0_1, OCPP_2_1 } from "../../types/OcppVersion";
import type { Transaction } from "../../connector/Transaction";
import { makeChargePoint } from "./chargePointFixtures";

/**
 * §4.9 ConnectionTimeOut: a connector that enters Preparing and does not
 * progress within the timeout goes to Finishing (the user did not present
 * an idTag in time). A connector whose transaction is running is past that
 * point: it stays in Preparing until StartTransaction.conf, which a CALLERROR
 * resend (#527) can hold back for longer than the timeout.
 */
function runningTransaction(): Transaction {
  return {
    id: 0,
    connectorId: 1,
    tagId: "TAG-CT",
    meterStart: 0,
    meterStop: null,
    startTime: new Date(),
    stopTime: null,
    meterSent: false,
  };
}

describe("ChargePoint ConnectionTimeOut (§4.9)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function chargePoint() {
    const cp = makeChargePoint();
    cp.configuration.applyChange("ConnectionTimeOut", "5");
    return cp;
  }

  it("moves a Preparing connector with no transaction to Finishing", () => {
    const cp = chargePoint();
    cp.updateConnectorStatus(1, OCPPStatus.Preparing);

    vi.advanceTimersByTime(4_999);
    expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Preparing);
    vi.advanceTimersByTime(1);
    expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Finishing);
  });

  it("leaves a Preparing connector alone once its transaction runs", () => {
    const cp = chargePoint();
    cp.getConnector(1)!.beginTransaction(runningTransaction());
    cp.updateConnectorStatus(1, OCPPStatus.Preparing);

    vi.advanceTimersByTime(60_000);
    expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Preparing);
  });

  it("a timer armed at plug-in does not fire once a transaction began", () => {
    const cp = chargePoint();
    cp.updateConnectorStatus(1, OCPPStatus.Preparing);
    vi.advanceTimersByTime(2_000);
    cp.getConnector(1)!.beginTransaction(runningTransaction());

    vi.advanceTimersByTime(60_000);
    expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Preparing);
  });

  it("a start on a plugged-in connector arms no new timer (#527)", async () => {
    const cp = chargePoint();
    cp.updateConnectorStatus(1, OCPPStatus.Preparing);
    vi.advanceTimersByTime(2_000);
    const outcome = await cp.startTransaction(
      "TAG-CT",
      1,
      undefined,
      undefined,
      {
        triggerReason: "RemoteStart",
      },
    );
    expect(outcome).toEqual({ started: true });

    vi.advanceTimersByTime(60_000);
    expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Preparing);
  });
});

/**
 * OCPP 2.x maps ConnectionTimeOut to TxCtrlr/EVConnectionTimeOut, which
 * targets exactly a transaction started before the cable is plugged in:
 * the running transaction does not hold the timer back there, and the timer
 * ends that transaction (E03.FR.05, #549).
 */
describe.each([OCPP_2_0_1, OCPP_2_1])(
  "ChargePoint ConnectionTimeOut on %s (EVConnectionTimeOut)",
  (ocppVersion) => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function chargePoint() {
      const cp = makeChargePoint({ ocppVersion });
      cp.configuration.applyChange("ConnectionTimeOut", "5");
      return cp;
    }

    /** The timer fired: the transaction is ended and the connector left
     *  Preparing (E03.FR.05, #549). */
    function expectTimedOut(cp: ReturnType<typeof chargePoint>) {
      expect(cp.getConnector(1)?.hasRunningTransaction).toBe(false);
      expect(cp.getConnector(1)?.status).not.toBe(OCPPStatus.Preparing);
    }

    it("fires while a transaction runs on a Preparing connector", () => {
      const cp = chargePoint();
      cp.getConnector(1)!.beginTransaction(runningTransaction());
      cp.updateConnectorStatus(1, OCPPStatus.Preparing);

      vi.advanceTimersByTime(4_999);
      expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Preparing);
      expect(cp.getConnector(1)?.hasRunningTransaction).toBe(true);
      vi.advanceTimersByTime(1);
      expectTimedOut(cp);
    });

    it("a timer armed at plug-in still fires once a transaction began", () => {
      const cp = chargePoint();
      cp.updateConnectorStatus(1, OCPPStatus.Preparing);
      vi.advanceTimersByTime(2_000);
      cp.getConnector(1)!.beginTransaction(runningTransaction());

      vi.advanceTimersByTime(3_000);
      expectTimedOut(cp);
    });

    it("a start on a plugged-in connector restarts the timer (#496)", async () => {
      const cp = chargePoint();
      cp.updateConnectorStatus(1, OCPPStatus.Preparing);
      vi.advanceTimersByTime(2_000);
      const outcome = await cp.startTransaction(
        "TAG-CT",
        1,
        undefined,
        undefined,
        {
          triggerReason: "RemoteStart",
        },
      );
      expect(outcome).toEqual({ started: true });

      vi.advanceTimersByTime(4_999);
      expect(cp.getConnector(1)?.status).toBe(OCPPStatus.Preparing);
      vi.advanceTimersByTime(1);
      expectTimedOut(cp);
    });
  },
);
