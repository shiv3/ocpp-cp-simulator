import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import {
  DefaultBootNotification,
  OCPPStatus,
} from "../../../domain/types/OcppTypes";
import { RECOVERY_SETTLE_MS } from "../OperationalTimelineProjector";

/**
 * #448: the projector turns ChargePoint domain events into timeline entries
 * and correlates an injected network fault with the recovery that follows.
 * It is driven through a real ChargePoint (no socket): the domain events a
 * live connection would produce are emitted by hand.
 */

const T0 = Date.UTC(2026, 9, 27, 15, 21, 10);

function buildChargePoint(
  ocppVersion = "OCPP-1.6J",
  connectorCount = 1,
): ChargePoint {
  return new ChargePoint(
    "CP-448",
    DefaultBootNotification,
    connectorCount,
    "ws://localhost:8080",
    null,
    null,
    null,
    {},
    [],
    ocppVersion,
    {},
  );
}

function armManualRule(cp: ChargePoint, reconnectDelayMs = 40_000): void {
  cp.setNetworkSimConfig({
    enabled: true,
    seed: 1,
    rules: { cut: { type: "manual-disconnect", reconnectDelayMs } },
  });
}

function bootAccepted(cp: ChargePoint): void {
  cp.events.emit("bootNotificationResult", {
    status: "Accepted",
    interval: 300,
    currentTime: new Date().toISOString(),
  });
}

describe("OperationalTimelineProjector (#448)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("correlates an injected fault with the reconnect and status recovery", () => {
    const cp = buildChargePoint();
    cp.updateConnectorStatus(1, OCPPStatus.Available);
    armManualRule(cp);
    const before = cp.timeline.query().total;

    vi.advanceTimersByTime(32_000);
    cp.triggerNetworkSimDisconnect("cut");
    cp.events.emit("disconnected", { code: 1006, reason: "" });
    cp.updateConnectorStatus(1, OCPPStatus.Unavailable);
    cp.events.emit("reconnecting", { attempt: 1, delayMs: 40_000 });
    vi.advanceTimersByTime(40_000);
    cp.events.emit("connected", undefined);
    bootAccepted(cp);
    vi.advanceTimersByTime(1_000);
    cp.updateConnectorStatus(1, OCPPStatus.Available);

    const entries = cp.timeline.query().entries.slice(before);
    expect(entries.map((e) => e.kind)).toEqual([
      "network_fault_injected",
      "disconnected",
      "connector_status",
      "reconnecting",
      "connected",
      "boot_notification",
      "connector_status",
      "recovery_completed",
    ]);
    const incidentId = entries[0]!.incidentId;
    expect(incidentId).toEqual(expect.any(String));
    expect(entries.every((e) => e.incidentId === incidentId)).toBe(true);
    expect(entries[0]!.data).toEqual({
      ruleId: "cut",
      ruleType: "manual-disconnect",
      reconnectDelayMs: 40_000,
    });
    expect(entries.at(-1)).toMatchObject({
      timestamp: "2026-10-27T15:22:23.000Z",
      data: { durationMs: 41_000, ruleId: "cut" },
    });

    // The incident is closed: later entries are not attributed to it.
    cp.updateConnectorStatus(1, OCPPStatus.Preparing);
    expect(cp.timeline.query().entries.at(-1)?.incidentId).toBeUndefined();
  });

  it("does not recover before the boot is accepted and statuses are back", () => {
    const cp = buildChargePoint();
    cp.updateConnectorStatus(1, OCPPStatus.Available);
    armManualRule(cp);

    cp.triggerNetworkSimDisconnect("cut");
    cp.events.emit("disconnected", { code: 1006, reason: "" });
    cp.updateConnectorStatus(1, OCPPStatus.Unavailable);
    cp.events.emit("connected", undefined);
    cp.events.emit("bootNotificationResult", {
      status: "Pending",
      interval: 10,
      currentTime: new Date().toISOString(),
    });
    cp.updateConnectorStatus(1, OCPPStatus.Available);
    expect(cp.timeline.query({ kinds: ["recovery_completed"] }).total).toBe(0);

    // A second drop before the boot is accepted resets the connection flags.
    cp.events.emit("disconnected", { code: 1006, reason: "" });
    bootAccepted(cp);
    expect(cp.timeline.query({ kinds: ["recovery_completed"] }).total).toBe(0);

    cp.events.emit("connected", undefined);
    bootAccepted(cp);
    expect(cp.timeline.query({ kinds: ["recovery_completed"] }).total).toBe(1);
  });

  it("closes an incident whose statuses never come back once the boot settles", () => {
    const cp = buildChargePoint();
    cp.updateConnectorStatus(1, OCPPStatus.Preparing);
    armManualRule(cp);

    cp.triggerNetworkSimDisconnect("cut");
    cp.events.emit("disconnected", { code: 1006, reason: "" });
    cp.updateConnectorStatus(1, OCPPStatus.Unavailable);
    cp.events.emit("connected", undefined);
    bootAccepted(cp);
    cp.updateConnectorStatus(1, OCPPStatus.Available);

    vi.advanceTimersByTime(RECOVERY_SETTLE_MS - 1);
    expect(cp.timeline.query({ kinds: ["recovery_completed"] }).total).toBe(0);
    vi.advanceTimersByTime(1);

    const recovery = cp.timeline.query({ kinds: ["recovery_completed"] })
      .entries[0];
    expect(recovery?.data).toEqual({
      durationMs: RECOVERY_SETTLE_MS,
      ruleId: "cut",
      restored: false,
      unrestored: [
        { connectorId: 1, expected: "Preparing", actual: "Available" },
      ],
    });
    cp.updateConnectorStatus(1, OCPPStatus.Charging);
    expect(cp.timeline.query().entries.at(-1)?.incidentId).toBeUndefined();
  });

  it("restarts the settle window when the connection drops again", () => {
    const cp = buildChargePoint();
    cp.updateConnectorStatus(1, OCPPStatus.Preparing);
    armManualRule(cp);

    cp.triggerNetworkSimDisconnect("cut");
    cp.events.emit("disconnected", { code: 1006, reason: "" });
    cp.events.emit("connected", undefined);
    bootAccepted(cp);
    cp.updateConnectorStatus(1, OCPPStatus.Available);
    vi.advanceTimersByTime(RECOVERY_SETTLE_MS / 2);
    cp.events.emit("disconnected", { code: 1006, reason: "" });
    vi.advanceTimersByTime(RECOVERY_SETTLE_MS);
    expect(cp.timeline.query({ kinds: ["recovery_completed"] }).total).toBe(0);

    cp.events.emit("connected", undefined);
    bootAccepted(cp);
    cp.updateConnectorStatus(1, OCPPStatus.Preparing);
    expect(
      cp.timeline.query({ kinds: ["recovery_completed"] }).entries[0]?.data,
    ).toMatchObject({ restored: true });
    vi.advanceTimersByTime(RECOVERY_SETTLE_MS);
    expect(cp.timeline.query({ kinds: ["recovery_completed"] }).total).toBe(1);
  });

  it("starts a new incident when a fault fires while one is open", () => {
    const cp = buildChargePoint();
    cp.updateConnectorStatus(1, OCPPStatus.Available);
    armManualRule(cp);

    cp.triggerNetworkSimDisconnect("cut");
    cp.events.emit("disconnected", { code: 1006, reason: "" });
    cp.events.emit("connected", undefined);
    // The controller allows one disconnect per socket session, and this
    // socket never really reopened: emit the second fault directly.
    cp.events.emit("networkFaultInjected", {
      ruleId: "cut",
      ruleType: "manual-disconnect",
      reconnectDelayMs: 40_000,
    });

    const faults = cp.timeline.query({
      kinds: ["network_fault_injected"],
    }).entries;
    expect(faults).toHaveLength(2);
    expect(faults[0]!.incidentId).not.toBe(faults[1]!.incidentId);
  });

  it("records CP and connector status changes, skipping repeats", () => {
    const cp = buildChargePoint();
    const before = cp.timeline.query().total;

    cp.updateConnectorStatus(1, OCPPStatus.Available);
    cp.updateConnectorStatus(1, OCPPStatus.Available);
    cp.updateConnectorStatus(0, OCPPStatus.Faulted);

    const entries = cp.timeline.query().entries.slice(before);
    expect(entries.map((e) => [e.kind, e.connectorId, e.data])).toEqual([
      [
        "connector_status",
        1,
        { from: expect.any(String), to: OCPPStatus.Available },
      ],
      ["status_change", undefined, { from: expect.any(String), to: "Faulted" }],
    ]);
  });

  it("never records the 1.6 placeholder transaction id", async () => {
    const cp = buildChargePoint("OCPP-1.6J");
    await cp.startTransaction("TAG-1", 1, undefined, undefined, {
      triggerReason: "RemoteStart",
    });
    cp.getConnector(1)!.transactionId = 42;
    cp.stopTransaction(1, "Local");

    const tx = cp.timeline.query({
      kinds: [
        "transaction_started",
        "transaction_id_assigned",
        "transaction_stopped",
      ],
    }).entries;
    expect(tx.map((e) => [e.kind, e.connectorId, e.data])).toEqual([
      ["transaction_started", 1, { tagId: "TAG-1" }],
      ["transaction_id_assigned", 1, { transactionId: 42 }],
      ["transaction_stopped", 1, { transactionId: 42, reason: "Local" }],
    ]);
  });

  it("uses the CP-minted id for OCPP 2.0.1 transactions", async () => {
    const cp = buildChargePoint("OCPP-2.0.1");
    await cp.startTransaction("TAG-2", 1, undefined, undefined, {
      triggerReason: "RemoteStart",
    });
    const cpTransactionId = cp.getConnector(1)!.transaction!.cpTransactionId;
    cp.stopTransaction(1);

    const tx = cp.timeline.query({
      kinds: ["transaction_started", "transaction_stopped"],
    }).entries;
    expect(cpTransactionId).toEqual(expect.any(String));
    expect(tx.map((e) => e.data.transactionId)).toEqual([
      cpTransactionId,
      cpTransactionId,
    ]);
  });

  it("records authorization and StartTransaction rejections, not acceptances", () => {
    const cp = buildChargePoint();

    cp.notifyAuthorizeResult("TAG-OK", "Accepted");
    cp.notifyAuthorizeResult("TAG-BAD", "Blocked");
    cp.notifyStartTransactionNotAccepted(1, "Invalid", true);

    const rejected = cp.timeline.query({
      kinds: ["authorization_rejected", "transaction_rejected"],
    }).entries;
    expect(rejected.map((e) => [e.kind, e.connectorId, e.data])).toEqual([
      [
        "authorization_rejected",
        undefined,
        { tagId: "TAG-BAD", status: "Blocked" },
      ],
      ["transaction_rejected", 1, { status: "Invalid", stopped: true }],
    ]);
  });
});
