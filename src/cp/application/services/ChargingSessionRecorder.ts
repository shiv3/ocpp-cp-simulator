import type { ChargePoint } from "../../domain/charge-point/ChargePoint";
import type { Connector } from "../../domain/connector/Connector";
import {
  toV201StoppedReason,
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
  /** The session each connector ended last, and the domain reason it ended
   *  with: 1.6 reports a rejected id only after its DeAuthorized stop. */
  private readonly lastEnded = new Map<
    number,
    { session: ChargingSession; reason: string | undefined }
  >();
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
   * Idempotent: a session marked interrupted by an earlier call comes back
   * as active once its transaction is restored.
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
      if (match) claimed.add(match.sessionId);
      const session: ChargingSession = match
        ? {
            ...match,
            transactionId:
              this.transactionIdOf(transaction) ?? match.transactionId,
            outcome: "active",
          }
        : this.newSession(connectorId, transaction);
      this.active.set(connectorId, session);
      this.store(session);
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
    const dangling = this.active.get(connectorId);
    if (dangling) this.store({ ...dangling, outcome: "interrupted" });
    const session = this.newSession(connectorId, transaction);
    this.active.set(connectorId, session);
    this.lastEnded.delete(connectorId);
    this.store(session);
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
    if (!transaction) return;
    const open =
      this.active.get(connectorId) ?? this.newSession(connectorId, transaction);
    this.active.delete(connectorId);
    const endedAt = (transaction.stopTime ?? this.now()).toISOString();
    const meterStopWh = transaction.meterStop;
    const session: ChargingSession = {
      ...open,
      transactionId: this.transactionIdOf(transaction) ?? open.transactionId,
      endedAt,
      durationMs: deriveDurationMs(open.startedAt, endedAt),
      meterStopWh,
      energyWh: deriveEnergyWh(open.meterStartWh, meterStopWh),
      stopReason: this.isV2
        ? (transaction.stoppedReason ??
          toV201StoppedReason(transaction.stopReason))
        : (transaction.stopReason ?? "Local"),
      triggerReason: this.isV2
        ? (transaction.stopTriggerReason ?? "StopAuthorized")
        : null,
      outcome: classifyEndedSession({
        reason,
        authorizationStatus: open.authorizationStatus,
      }),
    };
    this.lastEnded.set(connectorId, { session, reason });
    this.store(session);
  }

  private onNotAccepted(connectorId: number, status: string): void {
    const running = this.active.get(connectorId);
    if (running) {
      this.update(connectorId, { ...running, authorizationStatus: status });
      return;
    }
    // 1.6 and 2.x both stop on the rejection before reporting it.
    const ended = this.lastEnded.get(connectorId);
    if (!ended) return;
    const session: ChargingSession = {
      ...ended.session,
      authorizationStatus: status,
      outcome: classifyEndedSession({
        reason: ended.reason,
        authorizationStatus: status,
      }),
    };
    this.lastEnded.set(connectorId, { ...ended, session });
    this.store(session);
  }

  private onStartFailed(connectorId: number): void {
    const session = this.active.get(connectorId);
    if (!session) return;
    this.active.delete(connectorId);
    const endedAt = this.now().toISOString();
    const meterStopWh = this.cp.connectors.get(connectorId)?.meterValue ?? null;
    this.store({
      ...session,
      endedAt,
      durationMs: deriveDurationMs(session.startedAt, endedAt),
      meterStopWh,
      energyWh: deriveEnergyWh(session.meterStartWh, meterStopWh),
      outcome: "failed",
    });
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
