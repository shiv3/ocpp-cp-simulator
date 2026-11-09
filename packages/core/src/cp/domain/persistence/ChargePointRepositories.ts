import type { AuthorizationCacheRepository } from "./AuthorizationCacheRepository";
import type { ConfigurationOverrideRepository } from "./ConfigurationOverrideRepository";
import type { ConnectorSettingsRepository } from "./ConnectorSettingsRepository";
import type { VariableMonitorRepository } from "./VariableMonitorRepository";

/**
 * The stores one charge point persists its own state through (#878), each
 * bound to that charge point. `infrastructure/persistence/
 * createChargePointRepositories` builds them on the charge point's database,
 * or as no-ops without one; the charge point hands each to the domain object
 * that owns the state.
 */
export interface ChargePointRepositories {
  /** The Authorization Cache entries (`authorization_cache`). */
  readonly authorizationCache: AuthorizationCacheRepository;
  /** The configuration overrides (`configuration`). */
  readonly configuration: ConfigurationOverrideRepository;
  /** Per-connector availability (`connector_settings`). */
  readonly connectorSettings: ConnectorSettingsRepository;
  /** The OCPP 2.x variable monitors (`variable_monitors`). */
  readonly variableMonitors: VariableMonitorRepository;
}
