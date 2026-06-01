import type { AutoMeterValueConfig } from "../../cp/domain/connector/MeterValueCurve";
import type { ActiveChargingProfile } from "../../cp/domain/connector/Connector";
import type { Database } from "../../cp/domain/persistence/Database";
import type { OCPPAvailability } from "../../cp/domain/types/OcppTypes";
import type { ConnectorSettingsRepository } from "../interfaces/ConnectorSettingsRepository";

const SOC_METER_SYNC_KEY = "soc_meter_sync";

/**
 * SQLite-backed implementation of {@link ConnectorSettingsRepository}.
 *
 * `connector_settings` rows are upserted partial — we don't want to
 * clobber `auto_meter` when the caller is only changing `availability`,
 * so each setter writes its own column with an `INSERT ... ON CONFLICT
 * DO UPDATE` keyed on (cp_id, connector_id).
 *
 * Charging profiles live in their own table, one row per
 * (cp_id, connector_id, charging_profile_id), so we can delete or
 * inspect individual profiles without re-serialising the entire list.
 *
 * SoC↔Meter sync is a global UI pref shared across all CPs/connectors;
 * stored once in the `kv` table.
 */
export class SqliteConnectorSettingsRepository
  implements ConnectorSettingsRepository
{
  // Remote-mode path: the daemon owns connector settings, so when there's
  // no DB every reader returns the default (null / empty / sync=ON) and
  // every writer is a no-op. Same shape as the legacy localStorage code
  // had when localStorage was unavailable.
  constructor(private readonly db: Database | null) {}

  async loadAutoMeterValueConfig(
    chargePointId: string,
    connectorId: number,
  ): Promise<AutoMeterValueConfig | null> {
    if (!this.db) return null;
    const row = this.db.get<{ auto_meter: string | null }>(
      "SELECT auto_meter FROM connector_settings WHERE cp_id = ? AND connector_id = ?",
      [chargePointId, connectorId],
    );
    if (!row?.auto_meter) return null;
    try {
      return JSON.parse(row.auto_meter) as AutoMeterValueConfig;
    } catch {
      return null;
    }
  }

  async saveAutoMeterValueConfig(
    chargePointId: string,
    connectorId: number,
    config: AutoMeterValueConfig,
  ): Promise<void> {
    if (!this.db) return;
    this.db.run(
      "INSERT INTO connector_settings (cp_id, connector_id, auto_meter) " +
        "VALUES (?, ?, ?) " +
        "ON CONFLICT (cp_id, connector_id) DO UPDATE SET auto_meter = excluded.auto_meter",
      [chargePointId, connectorId, JSON.stringify(config)],
    );
  }

  async clearAutoMeterValueConfig(
    chargePointId: string,
    connectorId: number,
  ): Promise<void> {
    if (!this.db) return;
    this.db.run(
      "UPDATE connector_settings SET auto_meter = NULL " +
        "WHERE cp_id = ? AND connector_id = ?",
      [chargePointId, connectorId],
    );
  }

  async clearAllAutoMeterValueConfigs(chargePointId: string): Promise<void> {
    if (!this.db) return;
    this.db.run(
      "UPDATE connector_settings SET auto_meter = NULL WHERE cp_id = ?",
      [chargePointId],
    );
  }

  async loadChargingProfiles(
    chargePointId: string,
    connectorId: number,
  ): Promise<ActiveChargingProfile[]> {
    if (!this.db) return [];
    const rows = this.db.all<{ profile: string }>(
      "SELECT profile FROM charging_profiles WHERE cp_id = ? AND connector_id = ? " +
        "ORDER BY stack_level DESC",
      [chargePointId, connectorId],
    );
    return rows
      .map((r) => {
        try {
          return JSON.parse(r.profile) as ActiveChargingProfile;
        } catch {
          return null;
        }
      })
      .filter((p): p is ActiveChargingProfile => p !== null);
  }

  async saveChargingProfiles(
    chargePointId: string,
    connectorId: number,
    profiles: ActiveChargingProfile[],
  ): Promise<void> {
    if (!this.db) return;
    // Replace the per-(cp, connector) set atomically: clear then insert.
    // Keeps individual `chargingProfileId` rows queryable for §5.4
    // ClearChargingProfile filtering.
    this.db.run(
      "DELETE FROM charging_profiles WHERE cp_id = ? AND connector_id = ?",
      [chargePointId, connectorId],
    );
    for (const profile of profiles) {
      this.db.run(
        "INSERT INTO charging_profiles " +
          "(cp_id, connector_id, charging_profile_id, stack_level, purpose, profile) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
        [
          chargePointId,
          connectorId,
          profile.chargingProfileId,
          profile.stackLevel,
          profile.chargingProfilePurpose,
          JSON.stringify(profile),
        ],
      );
    }
  }

  async clearChargingProfiles(
    chargePointId: string,
    connectorId: number,
  ): Promise<void> {
    if (!this.db) return;
    this.db.run(
      "DELETE FROM charging_profiles WHERE cp_id = ? AND connector_id = ?",
      [chargePointId, connectorId],
    );
  }

  async clearAllChargingProfiles(chargePointId: string): Promise<void> {
    if (!this.db) return;
    this.db.run("DELETE FROM charging_profiles WHERE cp_id = ?", [
      chargePointId,
    ]);
  }

  async loadAvailability(
    chargePointId: string,
    connectorId: number,
  ): Promise<OCPPAvailability | null> {
    if (!this.db) return null;
    const row = this.db.get<{ availability: string | null }>(
      "SELECT availability FROM connector_settings WHERE cp_id = ? AND connector_id = ?",
      [chargePointId, connectorId],
    );
    if (
      row?.availability === "Operative" ||
      row?.availability === "Inoperative"
    )
      return row.availability;
    return null;
  }

  async saveAvailability(
    chargePointId: string,
    connectorId: number,
    availability: OCPPAvailability,
  ): Promise<void> {
    if (!this.db) return;
    this.db.run(
      "INSERT INTO connector_settings (cp_id, connector_id, availability) " +
        "VALUES (?, ?, ?) " +
        "ON CONFLICT (cp_id, connector_id) DO UPDATE SET availability = excluded.availability",
      [chargePointId, connectorId, availability],
    );
  }

  async loadSocMeterSync(): Promise<boolean> {
    if (!this.db) return true; // default ON
    const row = this.db.get<{ value: string }>(
      "SELECT value FROM kv WHERE key = ?",
      [SOC_METER_SYNC_KEY],
    );
    if (row?.value === "true") return true;
    if (row?.value === "false") return false;
    return true; // default ON, matches legacy behaviour
  }

  async saveSocMeterSync(enabled: boolean): Promise<void> {
    if (!this.db) return;
    this.db.run(
      "INSERT INTO kv (key, value) VALUES (?, ?) " +
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [SOC_METER_SYNC_KEY, enabled ? "true" : "false"],
    );
  }
}
