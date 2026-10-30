import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { ChargePointEvents } from "../../../domain/charge-point/ChargePointEvents";
import type {
  ActiveChargingProfile,
  Connector,
} from "../../../domain/connector/Connector";
import {
  ChargingProfileKindType,
  ChargingProfilePurposeType,
  ChargingRateUnitType,
  DefaultBootNotification,
  OCPPStatus,
} from "../../../domain/types/OcppTypes";
import { EventEmitter } from "../../../shared/EventEmitter";
import { OperationalTimeline, type TimelineKind } from "../OperationalTimeline";
import {
  OperationalTimelineProjector,
  RECOVERY_SETTLE_MS,
} from "../OperationalTimelineProjector";

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

  it("reports a durationMs equal to the gap between the fault and recovery timestamps (#504)", () => {
    // Each read advances the clock 1 ms more than the previous one, so two
    // separate reads for one event always disagree (a constant step would not).
    let now = T0;
    let step = 0;
    const timeline = new OperationalTimeline("CP-504", {
      now: () => (now += ++step),
    });
    const events = new EventEmitter<ChargePointEvents>();
    const projector = new OperationalTimelineProjector(
      timeline,
      events,
      new Map<number, Connector>(),
    );

    events.emit("networkFaultInjected", {
      ruleId: "cut",
      ruleType: "manual-disconnect",
      reconnectDelayMs: 40_000,
    });
    events.emit("connected", undefined);
    events.emit("bootNotificationResult", {
      status: "Accepted",
      interval: 300,
      currentTime: new Date(T0).toISOString(),
    });

    const entries = timeline.query().entries;
    expect(entries.map((e) => e.kind)).toEqual([
      "network_fault_injected",
      "connected",
      "boot_notification",
      "recovery_completed",
    ]);
    const fault = entries[0]!;
    const recovery = entries[3]!;
    expect(recovery.data.durationMs).toBeGreaterThan(0);
    expect(recovery.data.durationMs).toBe(
      Date.parse(recovery.timestamp) - Date.parse(fault.timestamp),
    );
    projector.dispose();
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
    cp.updateConnectorStatus(1, OCPPStatus.Available);
    cp.events.emit("connected", undefined);
    bootAccepted(cp);
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

  it("records a rejected and a discarded 2.x TransactionEvent (#490)", () => {
    const cp = buildChargePoint("OCPP-2.0.1");
    const report = {
      connectorId: 1,
      transactionId: "tx-490",
      action: "TransactionEvent" as const,
      eventType: "Started",
      reason: "callError" as const,
      errorCode: "InternalError",
    };

    cp.notifyTransactionMessageRejected({ ...report, attempt: 3 });
    cp.notifyTransactionMessageDiscarded({ ...report, attempts: 3 });

    const entries = cp.timeline.query({
      kinds: ["transaction_message_rejected", "transaction_message_discarded"],
    }).entries;
    const data = {
      transactionId: "tx-490",
      action: "TransactionEvent",
      eventType: "Started",
      reason: "callError",
      errorCode: "InternalError",
    };
    expect(entries.map((e) => [e.kind, e.connectorId, e.data])).toEqual([
      ["transaction_message_rejected", 1, { ...data, attempt: 3 }],
      ["transaction_message_discarded", 1, { ...data, attempts: 3 }],
    ]);
    expect(entries.map((e) => e.summary)).toEqual([
      "TransactionEvent Started of transaction tx-490 rejected (InternalError), attempt 3",
      "TransactionEvent Started of transaction tx-490 discarded after 3 attempts (InternalError)",
    ]);
  });

  it("records an unanswered 2.x TransactionEvent without an errorCode (#529)", () => {
    const cp = buildChargePoint("OCPP-2.1");
    const report = {
      connectorId: 1,
      transactionId: "tx-529",
      action: "TransactionEvent" as const,
      eventType: "Updated",
      reason: "timeout" as const,
    };

    cp.notifyTransactionMessageRejected({ ...report, attempt: 2 });
    cp.notifyTransactionMessageDiscarded({ ...report, attempts: 2 });

    const entries = cp.timeline.query({
      kinds: ["transaction_message_rejected", "transaction_message_discarded"],
    }).entries;
    const data = {
      transactionId: "tx-529",
      action: "TransactionEvent",
      eventType: "Updated",
      reason: "timeout",
    };
    expect(entries.map((e) => [e.kind, e.data])).toEqual([
      ["transaction_message_rejected", { ...data, attempt: 2 }],
      ["transaction_message_discarded", { ...data, attempts: 2 }],
    ]);
    expect(entries.map((e) => e.summary)).toEqual([
      "TransactionEvent Updated of transaction tx-529 got no answer, attempt 2",
      "TransactionEvent Updated of transaction tx-529 discarded after 2 attempts (no answer)",
    ]);
  });

  it("records a rejected and a discarded 1.6 StopTransaction, without eventType (#527)", () => {
    const cp = buildChargePoint();
    const report = {
      connectorId: 1,
      transactionId: "42",
      action: "StopTransaction" as const,
      reason: "callError" as const,
      errorCode: "InternalError",
    };

    cp.notifyTransactionMessageRejected({ ...report, attempt: 3 });
    cp.notifyTransactionMessageDiscarded({ ...report, attempts: 3 });

    const entries = cp.timeline.query({
      kinds: ["transaction_message_rejected", "transaction_message_discarded"],
    }).entries;
    const data = {
      transactionId: "42",
      action: "StopTransaction",
      reason: "callError",
      errorCode: "InternalError",
    };
    expect(entries.map((e) => [e.kind, e.connectorId, e.data])).toEqual([
      ["transaction_message_rejected", 1, { ...data, attempt: 3 }],
      ["transaction_message_discarded", 1, { ...data, attempts: 3 }],
    ]);
    expect(entries.map((e) => e.summary)).toEqual([
      "StopTransaction of transaction 42 rejected (InternalError), attempt 3",
      "StopTransaction of transaction 42 discarded after 3 attempts (InternalError)",
    ]);
  });
});

const PROFILE_KINDS: TimelineKind[] = [
  "charging_profile_applied",
  "charging_profile_cleared",
  "charging_profile_expired",
];

function txDefault(
  overrides: Partial<ActiveChargingProfile> = {},
): ActiveChargingProfile {
  return {
    chargingProfileId: 7,
    connectorId: 1,
    stackLevel: 2,
    chargingProfilePurpose: ChargingProfilePurposeType.TxDefaultProfile,
    chargingProfileKind: ChargingProfileKindType.Absolute,
    chargingRateUnit: ChargingRateUnitType.W,
    chargingSchedulePeriods: [{ startPeriod: 0, limit: 11_000 }],
    ...overrides,
  };
}

function profileEntries(cp: ChargePoint) {
  return cp.timeline
    .query({ kinds: PROFILE_KINDS })
    .entries.map((e) => [e.kind, e.connectorId, e.data]);
}

describe("OperationalTimelineProjector smart-charging profiles (#469)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records a connector profile set then cleared", () => {
    const cp = buildChargePoint();

    expect(cp.applyChargingProfile(txDefault(), "SetChargingProfile")).toBe(
      true,
    );
    cp.clearChargingProfiles(1, { profileId: 7 }, "ClearChargingProfile");

    expect(profileEntries(cp)).toEqual([
      [
        "charging_profile_applied",
        1,
        {
          connectorId: 1,
          profileId: 7,
          purpose: "TxDefaultProfile",
          stackLevel: 2,
          source: "SetChargingProfile",
          replaced: false,
        },
      ],
      [
        "charging_profile_cleared",
        1,
        {
          connectorId: 1,
          reason: "ClearChargingProfile",
          profiles: [
            { profileId: 7, purpose: "TxDefaultProfile", stackLevel: 2 },
          ],
        },
      ],
    ]);
  });

  it("records station-wide profiles without an entry-level connectorId", () => {
    const cp = buildChargePoint("OCPP-1.6J", 2);
    cp.applyChargingProfile(
      txDefault({
        chargingProfileId: 1,
        connectorId: 0,
        stackLevel: 0,
        chargingProfilePurpose:
          ChargingProfilePurposeType.ChargePointMaxProfile,
      }),
      "SetChargingProfile",
    );
    cp.applyChargingProfile(
      txDefault({ connectorId: 2 }),
      "SetChargingProfile",
    );

    // No connectorId: the station store and every connector, one entry per
    // scope that lost a profile.
    const cleared = cp.clearChargingProfiles(
      undefined,
      {},
      "ClearChargingProfile",
    );

    expect(cleared.map((c) => [c.connectorId, c.profiles.length])).toEqual([
      [0, 1],
      [2, 1],
    ]);
    expect(
      cp.timeline
        .query({ kinds: PROFILE_KINDS })
        .entries.map((e) => [e.kind, e.connectorId, e.data.connectorId]),
    ).toEqual([
      ["charging_profile_applied", undefined, 0],
      ["charging_profile_applied", 2, 2],
      ["charging_profile_cleared", undefined, 0],
      ["charging_profile_cleared", 2, 2],
    ]);
  });

  it("records a same-id update as one applied entry, and no entry when nothing is cleared", () => {
    const cp = buildChargePoint();
    cp.applyChargingProfile(txDefault(), "SetChargingProfile");
    cp.applyChargingProfile(txDefault({ stackLevel: 3 }), "SetChargingProfile");
    cp.clearChargingProfiles(1, { profileId: 999 }, "ClearChargingProfile");

    expect(profileEntries(cp).map(([kind, , data]) => [kind, data])).toEqual([
      [
        "charging_profile_applied",
        expect.objectContaining({ replaced: false }),
      ],
      [
        "charging_profile_applied",
        expect.objectContaining({ replaced: true, stackLevel: 3 }),
      ],
    ]);
    expect(cp.getConnector(1)!.chargingProfiles).toHaveLength(1);
  });

  it("does not apply a profile to an unknown connector", () => {
    const cp = buildChargePoint();
    expect(
      cp.applyChargingProfile(
        txDefault({ connectorId: 9 }),
        "SetChargingProfile",
      ),
    ).toBe(false);
    expect(profileEntries(cp)).toEqual([]);
  });

  it("records the TxProfile cleared when the transaction ends", async () => {
    const cp = buildChargePoint();
    await cp.startTransaction("TAG-1", 1, undefined, undefined, {
      triggerReason: "RemoteStart",
    });
    cp.applyChargingProfile(
      txDefault({
        chargingProfileId: 3,
        chargingProfilePurpose: ChargingProfilePurposeType.TxProfile,
      }),
      "SetChargingProfile",
    );
    cp.applyChargingProfile(txDefault(), "SetChargingProfile");
    cp.stopTransaction(1, "Local");

    const entries = cp.timeline.query({
      kinds: ["transaction_stopped", "charging_profile_cleared"],
    }).entries;
    expect(entries.map((e) => [e.kind, e.data.reason])).toEqual([
      ["transaction_stopped", "Local"],
      ["charging_profile_cleared", "TransactionEnded"],
    ]);
    expect(entries[1]!.data.profiles).toEqual([
      { profileId: 3, purpose: "TxProfile", stackLevel: 2 },
    ]);
    // Right after it: nothing is recorded in between.
    expect(entries[1]!.seq).toBe(entries[0]!.seq + 1);
    // The TxDefaultProfile outlives the transaction.
    expect(cp.getConnector(1)!.chargingProfiles).toHaveLength(1);
  });

  it("records the station profiles dropped when the connection closes", () => {
    const cp = buildChargePoint();
    cp.applyChargingProfile(
      txDefault({ chargingProfileId: 1, connectorId: 0 }),
      "SetChargingProfile",
    );
    cp.disconnect();

    expect(profileEntries(cp).at(-1)).toEqual([
      "charging_profile_cleared",
      undefined,
      {
        connectorId: 0,
        reason: "ConnectionClosed",
        profiles: [
          { profileId: 1, purpose: "TxDefaultProfile", stackLevel: 2 },
        ],
      },
    ]);
    expect(cp.stationProfiles.all()).toEqual([]);
  });

  it("does not record profiles restored from persistence", () => {
    const cp = buildChargePoint();
    cp.getConnector(1)!.setChargingProfiles([txDefault()]);
    expect(profileEntries(cp)).toEqual([]);
  });

  it("records the expiry when validTo passes", () => {
    const cp = buildChargePoint();
    const validTo = new Date(T0 + 60_000).toISOString();
    cp.applyChargingProfile(txDefault({ validTo }), "SetChargingProfile");

    expect(profileEntries(cp)[0]![2]).toMatchObject({ validTo });
    vi.advanceTimersByTime(59_999);
    expect(
      cp.timeline.query({ kinds: ["charging_profile_expired"] }).total,
    ).toBe(0);
    vi.advanceTimersByTime(1);

    const expired = cp.timeline.query({
      kinds: ["charging_profile_expired"],
    }).entries;
    expect(expired.map((e) => [e.connectorId, e.timestamp, e.data])).toEqual([
      [
        1,
        validTo,
        {
          connectorId: 1,
          profileId: 7,
          purpose: "TxDefaultProfile",
          stackLevel: 2,
          validTo,
        },
      ],
    ]);
    // Expired, not removed: the domain still holds it.
    expect(cp.getConnector(1)!.chargingProfiles).toHaveLength(1);
  });

  it("records an already-expired profile right after it is applied", () => {
    const cp = buildChargePoint();
    cp.applyChargingProfile(
      txDefault({ validTo: new Date(T0 - 1_000).toISOString() }),
      "SetChargingProfile",
    );
    expect(profileEntries(cp).map(([kind]) => kind)).toEqual([
      "charging_profile_applied",
      "charging_profile_expired",
    ]);
  });

  it("cancels the expiry when the profile is cleared or replaced", () => {
    const cp = buildChargePoint();
    const soon = new Date(T0 + 60_000).toISOString();
    cp.applyChargingProfile(txDefault({ validTo: soon }), "SetChargingProfile");
    cp.applyChargingProfile(
      txDefault({ chargingProfileId: 8, validTo: soon }),
      "SetChargingProfile",
    );
    cp.clearChargingProfiles(1, { profileId: 8 }, "ClearChargingProfile");
    // The update moves profile 7's expiry later.
    cp.applyChargingProfile(
      txDefault({ validTo: new Date(T0 + 120_000).toISOString() }),
      "SetChargingProfile",
    );

    vi.advanceTimersByTime(60_000);
    expect(
      cp.timeline.query({ kinds: ["charging_profile_expired"] }).total,
    ).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(
      cp.timeline
        .query({ kinds: ["charging_profile_expired"] })
        .entries.map((e) => e.data.profileId),
    ).toEqual([7]);
  });

  it("does not fire a far-future expiry early", () => {
    const cp = buildChargePoint();
    const DAY = 24 * 60 * 60 * 1000;
    // Past setTimeout's 2^31-1 ms (~24.8 days) ceiling.
    cp.applyChargingProfile(
      txDefault({ validTo: new Date(T0 + 30 * DAY).toISOString() }),
      "SetChargingProfile",
    );

    vi.advanceTimersByTime(30 * DAY - 1);
    expect(
      cp.timeline.query({ kinds: ["charging_profile_expired"] }).total,
    ).toBe(0);
    vi.advanceTimersByTime(1);
    expect(
      cp.timeline.query({ kinds: ["charging_profile_expired"] }).total,
    ).toBe(1);
  });

  it("records the profiles of a removed connector as cleared, and drops their expiry", () => {
    const cp = buildChargePoint("OCPP-1.6J", 2);
    cp.applyChargingProfile(
      txDefault({
        connectorId: 2,
        validTo: new Date(T0 + 60_000).toISOString(),
      }),
      "SetChargingProfile",
    );
    cp.removeConnector(2);

    expect(profileEntries(cp).at(-1)).toEqual([
      "charging_profile_cleared",
      2,
      {
        connectorId: 2,
        reason: "ConnectorRemoved",
        profiles: [
          { profileId: 7, purpose: "TxDefaultProfile", stackLevel: 2 },
        ],
      },
    ]);
    vi.advanceTimersByTime(60_000);
    expect(
      cp.timeline.query({ kinds: ["charging_profile_expired"] }).total,
    ).toBe(0);
  });

  it("drops pending expiries when the charge point is disposed", () => {
    const cp = buildChargePoint();
    cp.applyChargingProfile(
      txDefault({ validTo: new Date(T0 + 60_000).toISOString() }),
      "SetChargingProfile",
    );
    cp.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
