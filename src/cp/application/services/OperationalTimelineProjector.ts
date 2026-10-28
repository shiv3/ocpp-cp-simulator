import type { EventEmitter } from "../../shared/EventEmitter";
import type { ChargePointEvents } from "../../domain/charge-point/ChargePointEvents";
import type { Connector } from "../../domain/connector/Connector";
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
 */
export class OperationalTimelineProjector {
  private readonly unsubscribes: Array<() => void> = [];
  private incident: Incident | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

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
      this.incident = {
        ruleId,
        startedAt: this.timeline.now(),
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
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
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
    const durationMs = this.timeline.now() - incident.startedAt;
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

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)} s`;
}
