import type { OCPPAvailability } from "../types/OcppTypes";

/**
 * One charge point's per-connector settings (#878): the Operative /
 * Inoperative flag ChangeAvailability set, so "Unavailable persists across
 * reboots" (1.6 §5.2). Connector `0` is the charge point itself.
 *
 * `SqliteConnectorSettingsRepository` keeps them in the `connector_settings`
 * table; {@link NoopConnectorSettingsRepository} backs a charge point without
 * a database, which forgets them.
 */
export interface ConnectorSettingsRepository {
  /** The persisted flag, or `null` if no override is stored. */
  loadAvailability(connectorId: number): OCPPAvailability | null;
  saveAvailability(connectorId: number, availability: OCPPAvailability): void;
}

/** A charge point without a database: nothing is stored. */
export class NoopConnectorSettingsRepository implements ConnectorSettingsRepository {
  loadAvailability(_connectorId: number): OCPPAvailability | null {
    return null;
  }

  saveAvailability(
    _connectorId: number,
    _availability: OCPPAvailability,
  ): void {}
}
