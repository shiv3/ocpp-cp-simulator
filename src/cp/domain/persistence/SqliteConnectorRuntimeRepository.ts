import type { Transaction } from "../connector/Transaction";
import type { Database } from "./Database";
import type { OCPPAvailability, OCPPStatus } from "../types/OcppTypes";
import type {
  ConnectorRuntimeRepository,
  ConnectorRuntimeSnapshot,
  ScenarioPositionSnapshot,
} from "./ConnectorRuntimeRepository";

interface ConnectorRuntimeRow {
  status: string;
  availability: string;
  scheduled_availability: string | null;
  transaction_json: string | null;
  meter_value_wh: number;
  soc_percent: number | null;
  last_auto_started_scenario_key: string | null;
  scenario_position_json: string | null;
}

/**
 * SQLite-backed {@link ConnectorRuntimeRepository}. One row per
 * `(cp_id, connector_id)`. Transaction is serialised as JSON because the
 * shape (especially the optional reservation/stop-reason/EV fields) is
 * driven by OCPP and changes too often to track as relational columns.
 */
export class SqliteConnectorRuntimeRepository
  implements ConnectorRuntimeRepository
{
  constructor(private readonly database: Database) {}

  load(cpId: string, connectorId: number): ConnectorRuntimeSnapshot | null {
    const row = this.database.get<ConnectorRuntimeRow>(
      "SELECT status, availability, scheduled_availability, transaction_json, " +
        "meter_value_wh, soc_percent, last_auto_started_scenario_key, " +
        "scenario_position_json " +
        "FROM connector_runtime WHERE cp_id = ? AND connector_id = ?",
      [cpId, connectorId],
    );
    if (!row) return null;
    return {
      status: row.status as OCPPStatus,
      availability: row.availability as OCPPAvailability,
      scheduledAvailability:
        row.scheduled_availability == null
          ? null
          : (row.scheduled_availability as OCPPAvailability),
      transaction: deserializeTransaction(row.transaction_json),
      meterValueWh: row.meter_value_wh,
      socPercent: row.soc_percent,
      lastAutoStartedScenarioKey: row.last_auto_started_scenario_key,
      scenarioPosition: deserializeScenarioPosition(row.scenario_position_json),
    };
  }

  save(
    cpId: string,
    connectorId: number,
    snapshot: ConnectorRuntimeSnapshot,
  ): void {
    this.database.run(
      "INSERT INTO connector_runtime " +
        "(cp_id, connector_id, status, availability, scheduled_availability, " +
        " transaction_json, meter_value_wh, soc_percent, " +
        " last_auto_started_scenario_key, scenario_position_json, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (cp_id, connector_id) DO UPDATE SET " +
        "  status = excluded.status, " +
        "  availability = excluded.availability, " +
        "  scheduled_availability = excluded.scheduled_availability, " +
        "  transaction_json = excluded.transaction_json, " +
        "  meter_value_wh = excluded.meter_value_wh, " +
        "  soc_percent = excluded.soc_percent, " +
        "  last_auto_started_scenario_key = " +
        "    excluded.last_auto_started_scenario_key, " +
        "  scenario_position_json = excluded.scenario_position_json, " +
        "  updated_at = excluded.updated_at",
      [
        cpId,
        connectorId,
        snapshot.status,
        snapshot.availability,
        snapshot.scheduledAvailability,
        serializeTransaction(snapshot.transaction),
        snapshot.meterValueWh,
        snapshot.socPercent,
        snapshot.lastAutoStartedScenarioKey,
        serializeScenarioPosition(snapshot.scenarioPosition ?? null),
        new Date().toISOString(),
      ],
    );
  }

  delete(cpId: string, connectorId: number): void {
    this.database.run(
      "DELETE FROM connector_runtime WHERE cp_id = ? AND connector_id = ?",
      [cpId, connectorId],
    );
  }

  deleteByCpId(cpId: string): void {
    this.database.run("DELETE FROM connector_runtime WHERE cp_id = ?", [cpId]);
  }
}

function serializeTransaction(tx: Transaction | null): string | null {
  if (!tx) return null;
  // JSON.stringify hands Date instances to toISOString — sufficient for
  // startTime / stopTime. We never round-trip Date instances through
  // localStorage at this point, so collapsing them to strings is fine.
  return JSON.stringify(tx);
}

function deserializeTransaction(raw: string | null): Transaction | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as Transaction;
    // Restore Date instances stripped by JSON.stringify above.
    if (parsed.startTime && !(parsed.startTime instanceof Date)) {
      parsed.startTime = new Date(parsed.startTime as unknown as string);
    }
    if (parsed.stopTime && !(parsed.stopTime instanceof Date)) {
      parsed.stopTime = new Date(parsed.stopTime as unknown as string);
    }
    return parsed;
  } catch {
    return null;
  }
}

function serializeScenarioPosition(
  pos: ScenarioPositionSnapshot | null,
): string | null {
  if (!pos) return null;
  return JSON.stringify(pos);
}

function deserializeScenarioPosition(
  raw: string | null,
): ScenarioPositionSnapshot | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ScenarioPositionSnapshot>;
    // Light shape validation: reject silently if the row was hand-edited
    // or written by some future shape we don't recognise. Returning null
    // is equivalent to "no resume info; start from top" — the safe
    // fallback.
    if (
      typeof parsed.scenarioKey !== "string" ||
      !Array.isArray(parsed.executedNodes)
    ) {
      return null;
    }
    return {
      scenarioKey: parsed.scenarioKey,
      lastCompletedNodeId:
        typeof parsed.lastCompletedNodeId === "string"
          ? parsed.lastCompletedNodeId
          : null,
      executedNodes: parsed.executedNodes.filter(
        (n): n is string => typeof n === "string",
      ),
    };
  } catch {
    return null;
  }
}
