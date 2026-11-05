import type { EventEmitter } from "../../shared/EventEmitter";
import type { ChargePointEvents } from "../../domain/charge-point/ChargePointEvents";
import type {
  ActiveChargingProfile,
  Connector,
} from "../../domain/connector/Connector";
import { setTimeoutAt } from "../../shared/timers";
import type { OperationalTimeline } from "./OperationalTimeline";

/**
 * How long connector statuses get to come back once the CSMS has accepted a
 * BootNotification. Past it the incident closes anyway, as not restored.
 */
export const RECOVERY_SETTLE_MS = 60_000;

interface UnrestoredConnector {
  connectorId: number;
  expected: string;
  actual: string;
}

interface Incident {
  readonly ruleId: string;
  readonly startedAt: number;
  /** Status each connector had when the fault fired. */
  readonly expected: ReadonlyMap<number, string>;
  /** Connection since the fault: socket down, socket up, or up with a
   *  BootNotification the CSMS accepted on it. */
  link: "down" | "up" | "booted";
}

/**
 * Projects ChargePoint domain events into an `OperationalTimeline` (#448).
 *
 * Incident correlation: `networkFaultInjected` opens an incident, and every
 * entry recorded while it is open carries its id. The incident closes with
 * `recovery_completed` once the socket is connected again, the CSMS has
 * accepted a BootNotification on that connection, and every connector is
 * back to the status it had when the fault fired. Statuses that are still
 * off `RECOVERY_SETTLE_MS` after the boot close it with `restored: false`, so
 * an incident never stays open for good. A fault firing while an incident is
 * open replaces it; the replaced incident gets no recovery.
 *
 * Profile expiry (#469): the domain only skips a profile past its `validTo`
 * when it reads it, so the projector arms a timer per installed profile and
 * records `charging_profile_expired` when it passes. Clearing (removing its
 * connector included) or replacing the profile cancels the timer.
 */
export class OperationalTimelineProjector {
  private readonly unsubscribes: Array<() => void> = [];
  private incident: Incident | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** connectorId (0 = station) → profileId → cancel the pending expiry. */
  private readonly expiryTimers = new Map<number, Map<number, () => void>>();

  constructor(
    private readonly timeline: OperationalTimeline,
    events: EventEmitter<ChargePointEvents>,
    private readonly connectors: ReadonlyMap<number, Connector>,
  ) {
    const on = <K extends keyof ChargePointEvents>(
      event: K,
      listener: (data: ChargePointEvents[K]) => void,
    ) => this.unsubscribes.push(events.on(event, listener));

    on("connected", () => {
      if (this.incident) this.incident.link = "up";
      this.timeline.record({ kind: "connected", summary: "Connected" });
      this.checkRecovery();
    });
    on("disconnected", ({ code, reason }) => {
      if (this.incident) this.incident.link = "down";
      this.clearSettleTimer();
      this.timeline.record({
        kind: "disconnected",
        summary: `Disconnected (code ${code}${reason ? `: ${reason}` : ""})`,
        data: { code, reason },
      });
    });
    on("reconnecting", ({ attempt, delayMs }) => {
      this.timeline.record({
        kind: "reconnecting",
        summary: `Reconnect attempt ${attempt} in ${formatSeconds(delayMs)}`,
        data: { attempt, delayMs },
      });
    });
    on("bootNotificationResult", ({ status, interval }) => {
      if (this.incident?.link === "up" && status === "Accepted") {
        this.incident.link = "booted";
      }
      this.timeline.record({
        kind: "boot_notification",
        summary: `BootNotification ${status}`,
        data: { status, interval },
      });
      this.checkRecovery();
      if (this.incident?.link === "booted" && this.settleTimer === null) {
        this.settleTimer = setTimeout(() => {
          this.settleTimer = null;
          this.closeIncident(this.unrestoredConnectors().length === 0);
        }, RECOVERY_SETTLE_MS);
      }
    });
    on("statusChange", ({ status, previousStatus }) => {
      if (status === previousStatus) return;
      this.timeline.record({
        kind: "status_change",
        summary: `Charge point ${previousStatus} → ${status}`,
        data: { from: previousStatus, to: status },
      });
    });
    on("connectorStatusChange", ({ connectorId, status, previousStatus }) => {
      if (status === previousStatus) return;
      this.timeline.record({
        kind: "connector_status",
        connectorId,
        summary: `Connector ${connectorId} ${previousStatus} → ${status}`,
        data: { from: previousStatus, to: status },
      });
      this.checkRecovery();
    });
    on("networkFaultInjected", ({ ruleId, ruleType, reconnectDelayMs }) => {
      // Minted first, so a throw cannot leave a half-opened incident behind.
      const incidentId = crypto.randomUUID();
      this.clearSettleTimer();
      // One clock read for the incident's start and its entry, so the
      // recovery's durationMs is exactly the gap between the two entries.
      const startedAt = this.timeline.now();
      this.incident = {
        ruleId,
        startedAt,
        expected: new Map(
          [...this.connectors].map(([cid, c]) => [cid, c.status]),
        ),
        link: "down",
      };
      this.timeline.setActiveIncident(incidentId);
      this.timeline.record({
        kind: "network_fault_injected",
        summary: `Network fault injected by rule ${ruleId} (${ruleType}, reconnect blocked ${formatSeconds(reconnectDelayMs)})`,
        data: { ruleId, ruleType, reconnectDelayMs },
        at: startedAt,
      });
    });
    on("transactionStarted", ({ connectorId, tagId }) => {
      // The 1.6 id is a placeholder until StartTransaction.conf; it is
      // recorded by `transaction_id_assigned` instead.
      const transactionId =
        this.connectors.get(connectorId)?.transaction?.cpTransactionId;
      this.timeline.record({
        kind: "transaction_started",
        connectorId,
        summary: `Transaction started on connector ${connectorId}`,
        data: { tagId, ...(transactionId !== undefined && { transactionId }) },
      });
    });
    on("transactionStopped", ({ connectorId, transactionId, reason }) => {
      const id =
        this.connectors.get(connectorId)?.transaction?.cpTransactionId ??
        transactionId;
      this.timeline.record({
        kind: "transaction_stopped",
        connectorId,
        summary: `Transaction ${id} stopped on connector ${connectorId}${reason ? ` (${reason})` : ""}`,
        data: { transactionId: id, ...(reason !== undefined && { reason }) },
      });
    });
    on("authorizeResult", ({ tagId, status }) => {
      if (status === "Accepted") return;
      this.timeline.record({
        kind: "authorization_rejected",
        summary: `Authorization ${status}`,
        data: { tagId, status },
      });
    });
    on("startTransactionNotAccepted", ({ connectorId, status, stopped }) => {
      this.timeline.record({
        kind: "transaction_rejected",
        connectorId,
        summary: `StartTransaction ${status} on connector ${connectorId}${stopped ? ", stopped" : ""}`,
        data: { status, stopped },
      });
    });
    on("transactionMessageRejected", ({ connectorId, attempt, ...event }) => {
      const failure =
        event.reason === "timeout"
          ? "got no answer"
          : `rejected (${event.errorCode})`;
      this.timeline.record({
        kind: "transaction_message_rejected",
        connectorId,
        summary: `${transactionMessageLabel(event)} ${failure}, attempt ${attempt}`,
        data: { ...transactionMessageFields(event), attempt },
      });
    });
    on("transactionMessageDiscarded", ({ connectorId, attempts, ...event }) => {
      const cause = event.reason === "timeout" ? "no answer" : event.errorCode;
      this.timeline.record({
        kind: "transaction_message_discarded",
        connectorId,
        summary: `${transactionMessageLabel(event)} discarded after ${attempts} attempts (${cause})`,
        data: { ...transactionMessageFields(event), attempts },
      });
    });
    on(
      "chargingProfileApplied",
      ({ connectorId, profile, replaced, source }) => {
        const { chargingProfileId: id, validTo } = profile;
        this.timeline.record({
          kind: "charging_profile_applied",
          ...connectorScope(connectorId),
          summary: `Charging profile ${id} (${profile.chargingProfilePurpose}, stack level ${profile.stackLevel}) ${replaced ? "updated" : "applied"} ${scopeLabel(connectorId)}`,
          data: {
            ...profileFields(connectorId, profile),
            source,
            replaced,
            ...(validTo !== undefined && { validTo }),
          },
        });
        this.armExpiry(connectorId, profile);
      },
    );
    on("chargingProfilesCleared", ({ connectorId, profiles, reason }) => {
      for (const profile of profiles) {
        this.cancelExpiry(connectorId, profile.chargingProfileId);
      }
      this.timeline.record({
        kind: "charging_profile_cleared",
        ...connectorScope(connectorId),
        summary: `Charging profile ${profiles.map((p) => p.chargingProfileId).join(", ")} cleared ${scopeLabel(connectorId)} (${reason})`,
        data: { connectorId, reason, profiles: profiles.map(profileSummary) },
      });
    });

    // A removed connector is disposed, which drops this listener with it.
    for (const [connectorId, connector] of connectors) {
      this.unsubscribes.push(
        connector.events.on("transactionIdChange", ({ transactionId }) => {
          this.timeline.record({
            kind: "transaction_id_assigned",
            connectorId,
            summary: `CSMS assigned transaction id ${transactionId}`,
            data: { transactionId },
          });
        }),
      );
    }
  }

  dispose(): void {
    this.clearSettleTimer();
    for (const timers of this.expiryTimers.values()) {
      for (const cancel of timers.values()) cancel();
    }
    this.expiryTimers.clear();
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
  }

  /** Records the expiry at once when `validTo` has already passed. */
  private armExpiry(connectorId: number, profile: ActiveChargingProfile): void {
    const profileId = profile.chargingProfileId;
    this.cancelExpiry(connectorId, profileId);
    const { validTo } = profile;
    if (validTo === undefined) return;
    const expiresAt = Date.parse(validTo);
    if (Number.isNaN(expiresAt)) return;
    // Copied out so a pending timer does not hold the whole schedule.
    const data = { ...profileFields(connectorId, profile), validTo };
    const expire = () => {
      this.cancelExpiry(connectorId, profileId);
      this.timeline.record({
        kind: "charging_profile_expired",
        ...connectorScope(connectorId),
        summary: `Charging profile ${profileId} expired ${scopeLabel(connectorId)}`,
        data,
      });
    };
    if (expiresAt <= this.timeline.now()) {
      expire();
      return;
    }
    const cancel = setTimeoutAt(expiresAt, expire, {
      now: () => this.timeline.now(),
      // Weeks away, possibly: never the reason the process will not exit.
      unref: true,
    });
    const timers = this.expiryTimers.get(connectorId) ?? new Map();
    this.expiryTimers.set(connectorId, timers.set(profileId, cancel));
  }

  private cancelExpiry(connectorId: number, profileId: number): void {
    const timers = this.expiryTimers.get(connectorId);
    const cancel = timers?.get(profileId);
    if (!timers || cancel === undefined) return;
    cancel();
    timers.delete(profileId);
    if (timers.size === 0) this.expiryTimers.delete(connectorId);
  }

  private checkRecovery(): void {
    if (this.incident?.link !== "booted") return;
    if (this.unrestoredConnectors().length > 0) return;
    this.closeIncident(true);
  }

  /** Connectors (still present) whose status differs from the pre-fault one. */
  private unrestoredConnectors(): UnrestoredConnector[] {
    const unrestored: UnrestoredConnector[] = [];
    for (const [connectorId, expected] of this.incident?.expected ?? []) {
      const actual = this.connectors.get(connectorId)?.status;
      if (actual !== undefined && actual !== expected) {
        unrestored.push({ connectorId, expected, actual });
      }
    }
    return unrestored;
  }

  private closeIncident(restored: boolean): void {
    const incident = this.incident;
    if (!incident) return;
    this.clearSettleTimer();
    const at = this.timeline.now();
    const durationMs = at - incident.startedAt;
    const unrestored = this.unrestoredConnectors();
    this.timeline.record({
      kind: "recovery_completed",
      summary: restored
        ? `Recovered in ${formatSeconds(durationMs)} after rule ${incident.ruleId}`
        : `Reconnected after rule ${incident.ruleId}, but connector ${unrestored
            .map((c) => `${c.connectorId} ${c.expected} → ${c.actual}`)
            .join(", ")} not restored after ${formatSeconds(durationMs)}`,
      data: {
        durationMs,
        ruleId: incident.ruleId,
        restored,
        ...(!restored && { unrestored }),
      },
      at,
    });
    this.incident = null;
    this.timeline.setActiveIncident(null);
  }

  private clearSettleTimer(): void {
    if (this.settleTimer === null) return;
    clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }
}

type TransactionMessageFields = Omit<
  ChargePointEvents["transactionMessageRejected"],
  "connectorId" | "attempt"
>;

/** "TransactionEvent Started of transaction tx-1"; 1.6 messages carry no
 *  eventType. */
function transactionMessageLabel(event: TransactionMessageFields): string {
  const message = event.eventType
    ? `${event.action} ${event.eventType}`
    : event.action;
  return `${message} of transaction ${event.transactionId}`;
}

/** The `data` of a `transaction_message_*` entry: `eventType` and
 *  `errorCode` only when the event has them. */
function transactionMessageFields({
  transactionId,
  action,
  eventType,
  reason,
  errorCode,
}: TransactionMessageFields) {
  return {
    transactionId,
    action,
    ...(eventType !== undefined && { eventType }),
    reason,
    ...(errorCode !== undefined && { errorCode }),
  };
}

/** Station-wide profiles (connector 0) are charge-point-wide entries: the
 *  entry-level `connectorId` is set for a real connector only. */
function connectorScope(connectorId: number): { connectorId?: number } {
  return connectorId > 0 ? { connectorId } : {};
}

function scopeLabel(connectorId: number): string {
  return connectorId > 0 ? `on connector ${connectorId}` : "station-wide";
}

function profileSummary(profile: ActiveChargingProfile) {
  return {
    profileId: profile.chargingProfileId,
    purpose: profile.chargingProfilePurpose,
    stackLevel: profile.stackLevel,
  };
}

function profileFields(connectorId: number, profile: ActiveChargingProfile) {
  return { connectorId, ...profileSummary(profile) };
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)} s`;
}
