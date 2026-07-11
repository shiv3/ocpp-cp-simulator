import type { Transaction } from "../connector/Transaction";
import type { OCPPAvailability, OCPPStatus } from "../types/OcppTypes";

/**
 * The slice of {@link Connector} runtime state we persist between daemon
 * restarts. Kept deliberately small to avoid coupling persistence to the
 * full Connector implementation: only fields that are needed to resume
 * an in-flight transaction or hold a non-Available status across a
 * restart are included.
 *
 * Notable exclusions, documented so a future expansion is a conscious
 * choice rather than an oversight:
 *
 *   - Error code / error info / vendor error code: meaningful only while
 *     the connector is in a non-Operative state mid-conversation with
 *     the CSMS; resyncing them after a restart loses no information of
 *     value to the operator.
 *   - Auto-meter scheduler state: the schedule itself is reproducible
 *     from {@link ConnectorSettingsRepository}'s `auto_meter` row and
 *     the restored `meterValueWh`, so we don't store the scheduler's
 *     internal cursor.
 */
export interface ConnectorRuntimeSnapshot {
  status: OCPPStatus;
  availability: OCPPAvailability;
  scheduledAvailability: OCPPAvailability | null;
  /** Active OCPP transaction, or `null` when the connector is idle.
   *  Stored verbatim — `startTime` / `stopTime` round-trip as ISO 8601
   *  strings via `Transaction.toJSON()` semantics. */
  transaction: Transaction | null;
  meterValueWh: number;
  socPercent: number | null;
  /** Mirror of {@link Connector.lastAutoStartedScenarioKey}: prevents
   *  the auto-start path from re-firing the same scenario after a
   *  restart, which would otherwise reset the connector to the
   *  scenario's first node. */
  lastAutoStartedScenarioKey: string | null;
  /** Position of the in-flight scenario on this connector, persisted so
   *  a daemon restart mid-transaction can resume the scenario at the saved
   *  node rather than replaying from `start`. Null when no scenario is
   *  running, or when the scenario has finished. See
   *  {@link ScenarioPositionSnapshot} for the contract on resume semantics.
   *
   *  Optional for backward compatibility: snapshots written by older
   *  daemon builds (pre-v3 schema) won't carry this field, and load
   *  callers should treat its absence as "no resume info; start from top".
   */
  scenarioPosition?: ScenarioPositionSnapshot | null;
}

/**
 * Per-connector scenario execution checkpoint. Persisted on every node
 * completion so a daemon restart mid-flow can resume the scenario at the
 * node *after* the last completed one.
 *
 * Why `lastCompletedNodeId` and not `currentNodeId`?
 *   - Many scenario nodes have side effects (Plug In, Start Transaction).
 *     Re-running a side-effecting node on resume would double-send
 *     OCPP messages or contradict the restored connector state.
 *   - Saving "the node we finished" means resume walks the outgoing edge
 *     from that node, picking up at the next node — every node already
 *     in `executedNodes` is treated as "do not re-execute".
 *
 * `scenarioKey` identifies the executor instance the position belongs to
 * (the same key used by `Connector.lastAutoStartedScenarioKey`). The
 * resume path verifies the key matches the scenario the executor is
 * being re-armed with; a mismatch means the scenario tree changed and
 * we fall back to a fresh start (logged as a warning).
 */
export interface ScenarioPositionSnapshot {
  /** Stable identifier of the scenario instance, e.g.
   *  `essential-cp-behavior-shiv3-cp7-c1-1780480212898-z3cggj`. */
  scenarioKey: string;
  /** ID of the last node that finished executing. The resume path walks
   *  the outgoing edge from this node. Null when execution hasn't reached
   *  the first node yet — equivalent to "no resume info" and falls back
   *  to a fresh start. */
  lastCompletedNodeId: string | null;
  /** Full list of nodes that have been visited so far. Used by the resume
   *  path to skip nodes (so a parallel branch that already executed half
   *  its nodes doesn't re-execute them) and as the seed for the executor
   *  context's `executedNodes` after restore. */
  executedNodes: string[];
}

/**
 * Storage for {@link ConnectorRuntimeSnapshot}s, keyed on
 * `(cp_id, connector_id)`. Writes are idempotent: callers send the
 * full snapshot every time a connector field changes, and the
 * repository upserts the row.
 */
export interface ConnectorRuntimeRepository {
  /** Read the last-saved runtime snapshot for `(cpId, connectorId)`, or
   *  `null` if nothing is stored. Called during restore. */
  load(cpId: string, connectorId: number): ConnectorRuntimeSnapshot | null;

  /** Upsert the full snapshot. Intended to be called from a connector
   *  event listener that fires on every OCPP-visible state change. */
  save(
    cpId: string,
    connectorId: number,
    snapshot: ConnectorRuntimeSnapshot,
  ): void;

  /** Drop the row for one connector — called when a CP is being torn
   *  down via `DELETE /v1/cp/:cpId`. */
  delete(cpId: string, connectorId: number): void;

  /** Drop every row for a CP. Convenience for the cp-delete path so
   *  callers don't have to enumerate connector ids. */
  deleteByCpId(cpId: string): void;
}

/**
 * No-op implementation for environments without a SQL database (browser
 * local mode, daemon started without `--state-db`). Lets the rest of the
 * code stay unconditional without sprinkling `if (repo)` everywhere.
 */
export class NoopConnectorRuntimeRepository implements ConnectorRuntimeRepository {
  load(): ConnectorRuntimeSnapshot | null {
    return null;
  }
  save(): void {
    /* no-op */
  }
  delete(): void {
    /* no-op */
  }
  deleteByCpId(): void {
    /* no-op */
  }
}
