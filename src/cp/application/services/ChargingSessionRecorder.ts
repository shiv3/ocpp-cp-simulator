import type { ChargePoint } from "../../domain/charge-point/ChargePoint";
import type { Connector } from "../../domain/connector/Connector";
import {
  endedStoppedReason,
  endedTriggerReason,
  type Transaction,
} from "../../domain/connector/Transaction";
import type { ChargingSessionRepository } from "../../domain/persistence/ChargingSessionRepository";
import {
  classifyEndedSession,
  deriveDurationMs,
  deriveEnergyWh,
  type ChargingSession,
} from "../../domain/session/ChargingSession";
import { OCPP_2_0_1, OCPP_2_1 } from "../../domain/types/OcppVersion";

/** What the recorder reads off the charge point it is attached to. */
export type RecordedChargePoint = Pick<
  ChargePoint,
  "id" | "ocppVersion" | "events" | "connectors"
>;

export interface ChargingSessionRecorderOptions {
  now?: () => Date;
  newSessionId?: () => string;
}

/**
 * Projects a charge point's transaction lifecycle into the charging-session
 * history (#447), the same way `OperationalTimelineProjector` projects its
 * operational events.
 *
 * Every field is read from the connector's own `Transaction` when an event
 * fires, never from the wire: `transactionStopped` is emitted before the
 * connector is cleared, so the stop time, the meter and both reasons are
 * still there. The stop reason is stored as the encoder sends it (1.6
 * `reason`, 2.x `stoppedReason`); the outcome is classified from the
 * domain's own reason, which the 2.x encoder may fold (`UnlockCommand` →
 * `Other`).
 *
 * {@link reconcile} settles the sessions a previous process left without an
 * end: call it once the connectors' runtime state is in place.
 */
export class ChargingSessionRecorder {
  private readonly unsubscribes: Array<() => void> = [];
  private readonly listeners = new Set<(session: ChargingSession) => void>();
  /** The running session of each connector. */
  private readonly active = new Map<number, ChargingSession>();
  private readonly now: () => Date;
  private readonly newSessionId: () => string;
  private readonly isV2: boolean;

  constructor(
    private readonly cp: RecordedChargePoint,
    private readonly repository: ChargingSessionRepository,
    options: ChargingSessionRecorderOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newSessionId = options.newSessionId ?? (() => crypto.randomUUID());
    this.isV2 = cp.ocppVersion === OCPP_2_0_1 || cp.ocppVersion === OCPP_2_1;

    const events = cp.events;
    this.unsubscribes.push(
      events.on("transactionStarted", ({ connectorId }) =>
        this.onStarted(connectorId),
      ),
      events.on("transactionStopped", ({ connectorId, reason }) =>
        this.onStopped(connectorId, reason),
      ),
      events.on("startTransactionNotAccepted", ({ connectorId, status }) =>
        this.onNotAccepted(connectorId, status),
      ),
      events.on("transactionStartFailed", ({ connectorId }) =>
        this.onStartFailed(connectorId),
      ),
      // Removing a connector does not stop its transaction.
      events.on("connectorRemoved", ({ connectorId }) =>
        this.interrupt(connectorId),
      ),
    );
    // A removed connector is disposed, which drops this listener with it.
    for (const [connectorId, connector] of cp.connectors) {
      this.unsubscribes.push(
        connector.events.on("transactionIdChange", () =>
          this.onTransactionIdChange(connectorId, connector),
        ),
      );
    }
  }

  /** Called with every session the recorder stores, after it is stored. */
  onChange(listener: (session: ChargingSession) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Settle the sessions stored without an end (`endedAt === null`) against
   * the connectors as they are now.
   *
   * - A connector still running the transaction a session started (same
   *   start time) keeps it, active again: the daemon restored it.
   * - A running transaction with no such session gets a new one: it was
   *   restored from before this history existed.
   * - Every other unended session is `interrupted`, its end unknown.
   *
   * A session marked interrupted by an earlier call comes back as active if
   * its transaction does. A session already settled is not stored again.
   */
  reconcile(): void {
    const unended = this.repository.unended(this.cp.id);
    const claimed = new Set<string>();
    for (const [connectorId, connector] of this.cp.connectors) {
      const transaction = connector.transaction;
      if (!transaction || transaction.stopTime !== null) continue;
      const startedAt = transaction.startTime.toISOString();
      const match = unended.find(
        (s) =>
          s.connectorId === connectorId &&
          s.startedAt === startedAt &&
          !claimed.has(s.sessionId),
      );
      if (!match) {
        this.update(connectorId, this.newSession(connectorId, transaction));
        continue;
      }
      claimed.add(match.sessionId);
      const session: ChargingSession = {
        ...match,
        transactionId: this.transactionIdOf(transaction) ?? match.transactionId,
        outcome: "active",
      };
      this.active.set(connectorId, session);
      if (
        session.transactionId !== match.transactionId ||
        match.outcome !== "active"
      ) {
        this.store(session);
      }
    }
    for (const session of unended) {
      if (claimed.has(session.sessionId)) continue;
      if (session.outcome === "interrupted") continue;
      this.store({ ...session, outcome: "interrupted" });
    }
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
    this.listeners.clear();
  }

  private onStarted(connectorId: number): void {
    const transaction = this.cp.connectors.get(connectorId)?.transaction;
    if (!transaction) return;
    // A session still open here lost its end (no stop event reached us).
    this.interrupt(connectorId);
    this.update(connectorId, this.newSession(connectorId, transaction));
  }

  /** The running session of `connectorId`, if any, ends with its end
   *  unknown: interrupted, `endedAt` null. */
  private interrupt(connectorId: number): void {
    const session = this.active.get(connectorId);
    if (!session) return;
    this.active.delete(connectorId);
    this.store({ ...session, outcome: "interrupted" });
  }

  private onTransactionIdChange(
    connectorId: number,
    connector: Connector,
  ): void {
    const session = this.active.get(connectorId);
    const transaction = connector.transaction;
    if (!session || !transaction) return;
    const transactionId = this.transactionIdOf(transaction);
    if (transactionId === null || transactionId === session.transactionId) {
      return;
    }
    this.update(connectorId, { ...session, transactionId });
  }

  private onStopped(connectorId: number, reason: string | undefined): void {
    const transaction = this.cp.connectors.get(connectorId)?.transaction;
    const open = this.active.get(connectorId);
    // No running session: the transaction already ended, e.g. a failed
    // start that a reset path stops again (it stays on the connector until
    // the next start). A restored one was taken back by `reconcile`.
    if (!transaction || !open) return;
    // The handlers that stop on a rejected id record the verdict on the
    // transaction first, so it is here before `startTransactionNotAccepted`.
    const authorizationStatus =
      transaction.authorizationStatus ?? open.authorizationStatus;
    this.store({
      ...this.ended(connectorId, open, transaction),
      stopReason: this.isV2
        ? endedStoppedReason(transaction)
        : (transaction.stopReason ?? "Local"),
      triggerReason: this.isV2 ? endedTriggerReason(transaction) : null,
      authorizationStatus,
      outcome: classifyEndedSession({
        reason,
        authorizationStatus,
        rejectedMidSession: transaction.authorizationRejectedMidSession,
      }),
    });
  }

  /** A rejected id the station keeps charging on (no stop follows). */
  private onNotAccepted(connectorId: number, status: string): void {
    const running = this.active.get(connectorId);
    if (running) {
      this.update(connectorId, { ...running, authorizationStatus: status });
    }
  }

  private onStartFailed(connectorId: number): void {
    const session = this.active.get(connectorId);
    const transaction = this.cp.connectors.get(connectorId)?.transaction;
    if (!session || !transaction) return;
    this.store({
      ...this.ended(connectorId, session, transaction),
      outcome: "failed",
    });
  }

  /** `open` closed with `transaction`'s end, and no longer running. */
  private ended(
    connectorId: number,
    open: ChargingSession,
    transaction: Transaction,
  ): ChargingSession {
    this.active.delete(connectorId);
    const endedAt = (transaction.stopTime ?? this.now()).toISOString();
    const meterStopWh = transaction.meterStop;
    return {
      ...open,
      transactionId: this.transactionIdOf(transaction) ?? open.transactionId,
      endedAt,
      durationMs: deriveDurationMs(open.startedAt, endedAt),
      meterStopWh,
      energyWh: deriveEnergyWh(open.meterStartWh, meterStopWh),
    };
  }

  private newSession(
    connectorId: number,
    transaction: Transaction,
  ): ChargingSession {
    return {
      sessionId: this.newSessionId(),
      cpId: this.cp.id,
      connectorId,
      // The simulator gives each connector an EVSE of its own
      // (`v201TransactionEvse`).
      evseId: this.isV2 ? connectorId : null,
      ocppVersion: this.cp.ocppVersion,
      transactionId: this.transactionIdOf(transaction),
      idTag: transaction.tagId || null,
      startedAt: transaction.startTime.toISOString(),
      endedAt: null,
      durationMs: null,
      meterStartWh: transaction.meterStart,
      meterStopWh: null,
      energyWh: null,
      stopReason: null,
      triggerReason: null,
      authorizationStatus: null,
      outcome: "active",
    };
  }

  /** 2.x: the station-minted id; 1.6: the CSMS's, once it is not the 0
   *  placeholder. */
  private transactionIdOf(transaction: Transaction): string | null {
    if (transaction.cpTransactionId !== undefined) {
      return transaction.cpTransactionId;
    }
    return transaction.id !== 0 ? String(transaction.id) : null;
  }

  private update(connectorId: number, session: ChargingSession): void {
    this.active.set(connectorId, session);
    this.store(session);
  }

  private store(session: ChargingSession): void {
    this.repository.upsert(session);
    for (const listener of this.listeners) listener(session);
  }
}
