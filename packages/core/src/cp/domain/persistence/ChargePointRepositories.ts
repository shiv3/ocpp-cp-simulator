import type { ConnectorSettingsRepository } from "./ConnectorSettingsRepository";

/**
 * The stores one charge point persists its own state through (#878), each
 * bound to that charge point. `infrastructure/persistence/
 * createChargePointRepositories` builds them on the charge point's database,
 * or as no-ops without one; the charge point hands each to the domain object
 * that owns the state.
 */
export interface ChargePointRepositories {
  /** Per-connector availability (`connector_settings`). */
  readonly connectorSettings: ConnectorSettingsRepository;
}
