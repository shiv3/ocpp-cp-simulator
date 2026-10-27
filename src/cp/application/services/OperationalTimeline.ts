/**
 * Operational timeline (#448): a per-charge-point, in-memory projection of
 * the domain events that matter when reconstructing an incident — connection
 * loss and recovery, injected network faults, status transitions,
 * transactions, authorization rejections and scenario runs.
 *
 * It is an additional view: raw logs stay untouched, and scenario runs are
 * linked by `runId`, never copied. The kind vocabulary and the correlation
 * rules are documented in `docs/concepts/operational-timeline.md`.
 */

import { selectLogWindow, type LogWindowOptions } from "../../shared/window";

/** Bumped by minor for additive changes; consumers ignore unknown kinds. */
export const TIMELINE_FORMAT_VERSION = "1.0";

export const TIMELINE_KINDS = [
  "connected",
  "disconnected",
  "reconnecting",
  "boot_notification",
  "status_change",
  "connector_status",
  "network_fault_injected",
  "recovery_completed",
  "transaction_started",
  "transaction_id_assigned",
  "transaction_stopped",
  "transaction_rejected",
  "authorization_rejected",
  "scenario_started",
  "scenario_wait_changed",
  "scenario_error",
  "scenario_finished",
] as const;

export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export const TIMELINE_DEFAULT_CAPACITY = 1000;

export interface TimelineEntry {
  /** Per-charge-point, strictly increasing; the ordering contract. */
  readonly seq: number;
  /** ISO 8601, UTC. Several entries may share a millisecond. */
  readonly timestamp: string;
  readonly kind: TimelineKind;
  readonly cpId: string;
  readonly connectorId?: number;
  readonly runId?: string;
  readonly incidentId?: string;
  /** Human-readable; not a contract. */
  readonly summary: string;
  /** Kind-specific, machine-readable fields. */
  readonly data: Readonly<Record<string, unknown>>;
}

export interface TimelineRecord {
  kind: TimelineKind;
  summary: string;
  connectorId?: number;
  runId?: string;
  data?: Record<string, unknown>;
}

/** Exact-match filters, then the `logs.get` window over the matching
 *  entries (`limit` = newest N, `offset` pages back, `order`). */
export interface TimelineQuery extends LogWindowOptions {
  connectorId?: number;
  runId?: string;
  incidentId?: string;
  kinds?: TimelineKind[];
}

export interface TimelinePage {
  entries: TimelineEntry[];
  /** Matching entries before windowing. */
  total: number;
}

export interface OperationalTimelineOptions {
  capacity?: number;
  /** Epoch milliseconds; injectable for tests. */
  now?: () => number;
}

export class OperationalTimeline {
  private readonly entries: TimelineEntry[] = [];
  /** Runs in progress per connector, oldest first. */
  private readonly activeRuns = new Map<number, string[]>();
  private activeIncident: string | null = null;
  private readonly listeners = new Set<(entry: TimelineEntry) => void>();
  private readonly capacity: number;
  private nextSeq = 1;
  readonly now: () => number;

  constructor(
    readonly cpId: string,
    options: OperationalTimelineOptions = {},
  ) {
    this.capacity = options.capacity ?? TIMELINE_DEFAULT_CAPACITY;
    this.now = options.now ?? Date.now;
  }

  /**
   * Tag later entries on `connectorId` with `runId` until `endRun`. Scenario
   * runs are minted above the domain, so the service layer that owns them
   * calls this. A connector can carry two runs at once (one parked on a
   * trigger, one driven); entries go to the latest one still in progress.
   */
  startRun(connectorId: number, runId: string): void {
    const runs = this.activeRuns.get(connectorId) ?? [];
    this.activeRuns.set(connectorId, [
      ...runs.filter((r) => r !== runId),
      runId,
    ]);
  }

  /** Idempotent: ending a run that is not in progress does nothing. */
  endRun(connectorId: number, runId: string): void {
    const runs = this.activeRuns.get(connectorId)?.filter((r) => r !== runId);
    if (runs && runs.length > 0) this.activeRuns.set(connectorId, runs);
    else this.activeRuns.delete(connectorId);
  }

  /** Tag every later entry with `incidentId`, until cleared with `null`. */
  setActiveIncident(incidentId: string | null): void {
    this.activeIncident = incidentId;
  }

  /** Called with every entry as it is recorded; returns the unsubscribe.
   *  The daemon pushes them to clients as `timeline_entry` events. */
  onRecord(listener: (entry: TimelineEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  record(record: TimelineRecord): TimelineEntry {
    const runId =
      record.runId ??
      (record.connectorId !== undefined
        ? this.activeRuns.get(record.connectorId)?.at(-1)
        : undefined);
    const incidentId = this.activeIncident ?? undefined;
    // Frozen, so `query` can hand entries out without copying them.
    const entry: TimelineEntry = Object.freeze({
      seq: this.nextSeq++,
      timestamp: new Date(this.now()).toISOString(),
      kind: record.kind,
      cpId: this.cpId,
      ...(record.connectorId !== undefined && {
        connectorId: record.connectorId,
      }),
      ...(runId !== undefined && { runId }),
      ...(incidentId !== undefined && { incidentId }),
      summary: record.summary,
      data: Object.freeze({ ...record.data }),
    });
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    for (const listener of this.listeners) listener(entry);
    return entry;
  }

  query(query: TimelineQuery = {}): TimelinePage {
    const kinds = query.kinds ? new Set(query.kinds) : null;
    const matching = this.entries.filter(
      (e) =>
        (query.connectorId === undefined ||
          e.connectorId === query.connectorId) &&
        (query.runId === undefined || e.runId === query.runId) &&
        (query.incidentId === undefined || e.incidentId === query.incidentId) &&
        (kinds === null || kinds.has(e.kind)),
    );
    return {
      entries: selectLogWindow(matching, query),
      total: matching.length,
    };
  }
}
