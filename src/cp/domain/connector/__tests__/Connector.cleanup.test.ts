import { describe, it, expect } from "vitest";
import { Connector } from "../Connector";
import { Logger, LogLevel } from "../../../shared/Logger";
import { OCPPStatus } from "../../types/OcppTypes";
import type { Transaction } from "../Transaction";

function makeConnector(): Connector {
  // ERROR-level logger so tests stay quiet without overriding stdout.
  return new Connector(1, new Logger(LogLevel.ERROR));
}

function makeTransaction(id: number | null = 42): Transaction {
  return {
    id,
    connectorId: 1,
    tagId: "test-tag",
    meterStart: 0,
    meterStop: null,
    startTime: new Date(),
    stopTime: null,
    meterSent: false,
  };
}

describe("Connector.cleanup", () => {
  it("does not clear transactionValue on cleanup", () => {
    // Why: cleanup() is called from ChargePoint.teardownAfterClose on every
    // WebSocket close, including transient CSMS-side restarts where the
    // simulator daemon stays alive. If we null transactionValue here, the
    // post-boot StatusNotification fan-out in BootNotificationResultHandler
    // takes the autoReset-to-Available branch and orphans the in-flight
    // transaction id at the CSMS side. The connector_runtime sqlite snapshot
    // is the source of truth for daemon restarts; in-memory values must
    // survive a WS-only reconnect to cover the CSMS-restart case.
    const connector = makeConnector();
    const tx = makeTransaction();
    connector.beginTransaction(tx);
    expect(connector.transaction).not.toBeNull();

    connector.cleanup();

    expect(connector.transaction).not.toBeNull();
    expect(connector.transaction?.id).toBe(42);
  });

  it("does not clear socPercent on cleanup", () => {
    // Same reasoning as transactionValue: the connector's SoC must survive
    // a WS-only reconnect so the CSMS sees a consistent meter trail
    // across the boot/StatusNotification fan-out.
    const connector = makeConnector();
    connector.beginTransaction(makeTransaction());
    connector.soc = 72;
    expect(connector.soc).toBe(72);

    connector.cleanup();

    expect(connector.soc).toBe(72);
  });

  it("status survives cleanup so BootNotificationResultHandler keeps it", () => {
    // BootNotificationResultHandler reads connector.status to decide whether
    // to fan out the resumed status (Preparing / Charging) or reset to
    // Available. cleanup() must not move us off the live status.
    const connector = makeConnector();
    connector.restoreRuntimeSnapshot({
      status: OCPPStatus.Charging,
      availability: connector.availability,
      scheduledAvailability: null,
      transaction: makeTransaction(),
      meterValueWh: 0,
      socPercent: null,
      lastAutoStartedScenarioKey: null,
    });
    expect(connector.status).toBe(OCPPStatus.Charging);

    connector.cleanup();

    expect(connector.status).toBe(OCPPStatus.Charging);
  });
});
