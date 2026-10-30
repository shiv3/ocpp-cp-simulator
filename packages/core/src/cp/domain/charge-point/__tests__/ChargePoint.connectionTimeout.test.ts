import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OCPPStatus } from "../../types/OcppTypes";
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
});
