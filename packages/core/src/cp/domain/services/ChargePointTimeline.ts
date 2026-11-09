import type { TIMELINE_KINDS } from "@ocpp-cp-simulator/contracts/timeline";
import type { LogWindowOptions } from "../../shared/window";

export type TimelineKind = (typeof TIMELINE_KINDS)[number];

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
  /** Epoch ms to stamp the entry with, when the caller already read the
   *  clock for its data (a duration); defaults to `now()`. */
  at?: number;
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

/**
 * The operational timeline (#448, docs/concepts/operational-timeline.md) as
 * the charge point and the code around it use it. `OperationalTimeline`
 * (application) implements it; `ChargePoint.timeline` returns it.
 */
export interface ChargePointTimeline {
  /** Tag later entries on `connectorId` with `runId` until `endRun`. */
  startRun(connectorId: number, runId: string): void;
  /** Idempotent: ending a run that is not in progress does nothing. */
  endRun(connectorId: number, runId: string): void;
  record(record: TimelineRecord): TimelineEntry;
  query(query?: TimelineQuery): TimelinePage;
  /** Called with every entry as it is recorded; returns the unsubscribe. */
  onRecord(listener: (entry: TimelineEntry) => void): () => void;
}

/**
 * What the charge point keeps of the projector that feeds its timeline from
 * its events: the way to stop it. `OperationalTimelineProjector`
 * (application) implements it.
 */
export interface ChargePointTimelineProjector {
  dispose(): void;
}
