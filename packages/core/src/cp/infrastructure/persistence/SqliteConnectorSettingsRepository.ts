import type { Database } from "../../domain/persistence/Database";
import type { ConnectorSettingsRepository } from "../../domain/persistence/ConnectorSettingsRepository";
import type { OCPPAvailability } from "../../domain/types/OcppTypes";

/** One charge point's rows of the `connector_settings` table (#878). */
export class SqliteConnectorSettingsRepository implements ConnectorSettingsRepository {
  constructor(
    private readonly chargePointId: string,
    private readonly database: Database,
  ) {}

  loadAvailability(connectorId: number): OCPPAvailability | null {
    const row = this.database.get<{ availability: string | null }>(
      "SELECT availability FROM connector_settings WHERE cp_id = ? AND connector_id = ?",
      [this.chargePointId, connectorId],
    );
    if (
      row?.availability === "Operative" ||
      row?.availability === "Inoperative"
    ) {
      return row.availability;
    }
    return null;
  }

  saveAvailability(connectorId: number, availability: OCPPAvailability): void {
    this.database.run(
      "INSERT INTO connector_settings (cp_id, connector_id, availability) " +
        "VALUES (?, ?, ?) " +
        "ON CONFLICT (cp_id, connector_id) DO UPDATE SET availability = excluded.availability",
      [this.chargePointId, connectorId, availability],
    );
  }
}
