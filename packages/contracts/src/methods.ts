// The rpc method table — the single typed contract for every client→server
// call. CP-command keys are the jsonMode command ids VERBATIM (identity
// dispatch: the server routes them straight through `handleJsonCommand`).
// The dotted keys are the non-jsonMode explicit ops.
//
// Connector rule (PB3): only `update_connector_status` accepts connector 0
// (`CONN_NONNEG`); every other connector-taking command requires >= 1
// (`CONN_POS`). DoS limits (Sec-4) bound every string/array.
//
// On the daemon the handlers receive the value these schemas parsed (#383), so
// a rule about the params themselves belongs here rather than in a handler.

import type { z } from "zod";
import { VEHICLE_METHODS } from "./vehicle";
import { CP_COMMAND_METHODS } from "./methods/cpCommandMethods";
import { SCENARIO_METHODS } from "./methods/scenarioMethods";
import { NETWORK_POWER_METHODS } from "./methods/networkPowerMethods";
import { DAEMON_METHODS } from "./methods/daemonMethods";

// Re-exports: every schema and type that used to be defined in this file.
export {
  SCENARIO_MODES,
  SCENARIO_RUNS_PAGE_DEFAULT,
  SCENARIO_RUNS_PAGE_MAX,
  CHARGING_SESSIONS_PAGE_DEFAULT,
  CHARGING_SESSIONS_PAGE_MAX,
  CONFIG_KEY_SET_STATUSES,
  dataTransferDataSchema,
  authorizationCacheSeedSchema,
  scenarioWaitExtensionSecondsSchema,
  behaviorIdsSchema,
  BEHAVIOR_PARAMS_MAX_BYTES,
  behaviorParamsSchema,
} from "./schemas/common";
export {
  createParamsSchema,
  cpProbeParamsSchema,
  createManyParamsSchema,
  hasIdPatternPlaceholder,
  MAX_GENERATED_CP_ID_LENGTH,
  expandIdPattern,
  cpListParamsSchema,
  cpLabelsSetParamsSchema,
  cpBehaviorsSetParamsSchema,
  behaviorParamsInfoSchema,
  behaviorListResultSchema,
  behaviorReloadParamsSchema,
  behaviorReloadResultSchema,
  CP_BULK_ACTIONS,
  cpBulkParamsSchema,
  cpBulkResultSchema,
  cpScenarioRunParamsSchema,
  cpScenarioRunResultSchema,
} from "./schemas/cp";
export type { CpBulkResult, CpScenarioRunResult } from "./schemas/cp";
export {
  blueprintSchema,
  FLEET_TEMPLATE_MAX_CPS,
  fleetMemberSchema,
  fleetGroupSchema,
  fleetTemplateSchema,
  fleetCreateParamsSchema,
  fleetCreateResultSchema,
  serverInfoSchema,
  createManyToolSchema,
  createManyFromBlueprintSchema,
} from "./schemas/fleet";
export type {
  Blueprint,
  FleetMember,
  FleetGroup,
  FleetTemplate,
  FleetCreateParams,
  FleetCreateResult,
  ServerInfo,
} from "./schemas/fleet";

// Key order is part of the contract (it shows up in `rpc.methods` and the MCP
// `list_methods`): lifecycle .. history, scenarios, modem / network / power,
// the explicit ops, then the vehicle methods.
export const METHODS = {
  ...CP_COMMAND_METHODS,
  ...SCENARIO_METHODS,
  ...NETWORK_POWER_METHODS,
  ...DAEMON_METHODS,
  // #458: saved vehicle profiles, and the catalog an import reads through the
  // daemon so the API key stays server-side.
  ...VEHICLE_METHODS,
} satisfies Record<string, { params: z.ZodTypeAny; result: z.ZodTypeAny }>;

/** The explicit (non-jsonMode) op ids — routed to dedicated server handlers. */
export const EXPLICIT_METHODS = [
  "cp.list",
  "cp.create",
  "cp.probe",
  "cp.create_many",
  "blueprint.list",
  "blueprint.save",
  "blueprint.delete",
  "fleet.template.list",
  "fleet.template.get",
  "fleet.template.save",
  "fleet.template.delete",
  "fleet.create",
  "cp.update",
  "cp.delete",
  "cp.labels.set",
  "cp.behaviors.set",
  "behavior.list",
  "behavior.reload",
  "cp.bulk",
  "cp.scenario.run",
  "logs.get",
  "logs.clear",
  "state.reset",
  "config.get",
  "config.save",
  "scenario.templates",
  "scenario.runs.list",
  "timeline.get",
  "sessions.list",
  "cp.config_keys.get",
  "cp.config_keys.set",
  "scenario.definitions.list",
  "scenario.definitions.save",
  "scenario.definitions.replace",
  "scenario.definitions.delete",
  "connector_settings.auto_meter.get",
  "connector_settings.auto_meter.save",
  "connector_settings.auto_traffic.get",
  "connector_settings.auto_traffic.save",
  "connector_settings.soc_meter_sync.get",
  "connector_settings.soc_meter_sync.save",
  "ev_settings.apply_default",
  "server.shutdown",
  "server.info",
  "events.subscribe",
  "events.unsubscribe",
  "modem.get",
  "modem.command",
  "network_sim.global.get",
  "network_sim.global.save",
  "network_sim.cp.get",
  "network_sim.cp.save",
  "network_sim.cellular.get",
  "network_sim.cellular.save",
  "network_sim.cellular.status",
  "network_sim.disconnect.trigger",
  "power.loss",
  "power.restore",
  "vehicle_profiles.list",
  "vehicle_profiles.save",
  "vehicle_profiles.delete",
  "vehicle_catalog.list_makes",
  "vehicle_catalog.search_models",
  "vehicle_catalog.list_variants",
  "vehicle_catalog.get_variant",
] as const;
