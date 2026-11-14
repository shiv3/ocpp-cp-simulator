import { describe, expect, it } from "vitest";
import { Connector } from "../Connector";
import { evConnectionOf } from "../EvConnection";
import { Logger, LogLevel } from "../../../shared/Logger";
import { OCPPStatus } from "../../types/OcppTypes";
import type { Transaction } from "../Transaction";

/**
 * #453 — the connector's EV and cable state: three observable states, a
 * transaction implies an EV on the cable, a restart infers the cable from what
 * the snapshot proves and invents no transition.
 */

function transaction(stopTime: Date | null = null): Transaction {
  return {
    id: 9,
    connectorId: 1,
    tagId: "TAG-453",
    meterStart: 0,
    meterStop: null,
    startTime: new Date("2026-11-09T00:00:00.000Z"),
    stopTime,
    meterSent: false,
  };
}

const newConnector = (): Connector =>
  new Connector(1, new Logger(LogLevel.ERROR));

function snapshot(status: OCPPStatus, tx: Transaction | null) {
  return {
    status,
    availability: "Operative" as never,
    scheduledAvailability: null,
    transaction: tx,
    meterValueWh: 0,
    socPercent: null,
    lastAutoStartedScenarioKey: null,
  };
}

describe("Connector EV connection (#453)", () => {
  it("evConnectionOf names the three states", () => {
    expect(evConnectionOf(false, true)).toBe("disconnected");
    expect(evConnectionOf(false, false)).toBe("disconnected");
    expect(evConnectionOf(true, true)).toBe("connected-ready");
    expect(evConnectionOf(true, false)).toBe("connected-not-ready");
  });

  it("starts disconnected, plugs in ready, unplugs and resets readiness", () => {
    const connector = newConnector();
    expect(connector.evConnection).toBe("disconnected");
    connector.markEvPluggedIn();
    expect(connector.evConnection).toBe("connected-ready");
    connector.markEvReady(false);
    expect(connector.evConnection).toBe("connected-not-ready");
    connector.markEvUnplugged();
    expect(connector.evConnection).toBe("disconnected");
    connector.markEvPluggedIn();
    expect(connector.evConnection).toBe("connected-ready");
  });

  it("a transaction implies a plugged-in, ready EV", () => {
    const connector = newConnector();
    connector.beginTransaction(transaction());
    expect(connector.evConnection).toBe("connected-ready");
  });

  it("a restart infers the cable from a running transaction or a cable-only status", () => {
    const running = newConnector();
    running.restoreRuntimeSnapshot(
      snapshot(OCPPStatus.Charging, transaction()),
    );
    expect(running.evConnection).toBe("connected-ready");

    const suspended = newConnector();
    suspended.restoreRuntimeSnapshot(
      snapshot(OCPPStatus.SuspendedEV, transaction()),
    );
    expect(suspended.evConnection).toBe("connected-not-ready");

    const preparing = newConnector();
    preparing.restoreRuntimeSnapshot(snapshot(OCPPStatus.Preparing, null));
    expect(preparing.evConnection).toBe("connected-ready");
  });

  it("a restart invents no cable for an idle or unavailable connector", () => {
    for (const status of [
      OCPPStatus.Available,
      OCPPStatus.Unavailable,
      OCPPStatus.Faulted,
      OCPPStatus.Reserved,
    ]) {
      const connector = newConnector();
      connector.restoreRuntimeSnapshot(snapshot(status, null));
      expect(connector.evConnection).toBe("disconnected");
    }
    const ended = newConnector();
    ended.restoreRuntimeSnapshot(
      snapshot(OCPPStatus.Available, transaction(new Date())),
    );
    expect(ended.evConnection).toBe("disconnected");
  });

  it("keeps ev_ready(false) recorded before the start (#846)", () => {
    const connector = newConnector();
    connector.markEvPluggedIn();
    connector.markEvReady(false);
    connector.beginTransaction(transaction());
    expect(connector.evConnection).toBe("connected-not-ready");
  });

  it("a start without a prior plug-in implies a ready EV (#846)", () => {
    const connector = newConnector();
    connector.markEvReady(false);
    connector.beginTransaction(transaction());
    expect(connector.evConnection).toBe("connected-ready");
  });
});
