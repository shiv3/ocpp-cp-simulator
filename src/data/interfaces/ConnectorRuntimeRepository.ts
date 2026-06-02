import type { Transaction } from "../../cp/domain/connector/Transaction";
import type {
  OCPPAvailability,
  OCPPStatus,
} from "../../cp/domain/types/OcppTypes";

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
 *   - Scenario execution position: the daemon doesn't yet know how to
 *     freeze and thaw a Robot3 service mid-flow, so we let scenarios
 *     re-arm from the top on restart. A connector that was Charging
 *     will resume the OCPP transaction (StopTransaction goes out
 *     correctly on the next RemoteStop), but its scenario node
 *     position is lost.
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
export class NoopConnectorRuntimeRepository
  implements ConnectorRuntimeRepository
{
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
