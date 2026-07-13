// The rpc method table — the single typed contract for every client→server
// call. CP-command keys are the jsonMode command ids VERBATIM (identity
// dispatch: the server routes them straight through `handleJsonCommand`).
// The dotted keys are the non-jsonMode explicit ops.
//
// Connector rule (PB3): only `update_connector_status` accepts connector 0
// (`requireNonNegativeInt`); every other connector-taking command requires
// >= 1 (`requirePositiveInt`). DoS limits (Sec-4) bound every string/array.

import { z } from "zod";

import {
  ARRAY_1000,
  OBJ_MAX_BYTES,
  SCENARIO_MAX_BYTES,
  STR_64K,
  boundedObject,
} from "./limits";
import {
  cpListItemSchema,
  simulatorConfigInputSchema,
  statusWireSchema,
  wireSimulatorConfigSchema,
} from "./events";
import { subscribeResultSchema } from "./envelope";

const CONN_POS = z.number().int().min(1);
const CONN_NONNEG = z.number().int().min(0);
const CONN_DEF = CONN_POS.nullable();
const EMPTY = z.object({});
const ANY = z.unknown();
/** A bounded free-form object param (settings/config/options): ≤ 64 KB. */
const OBJ = () => boundedObject(OBJ_MAX_BYTES);
/** A bounded scenario-definition object param: ≤ 256 KB. */
const SCENARIO_OBJ = () => boundedObject(SCENARIO_MAX_BYTES);

const cpParamsBaseSchema = z.object({
  cpId: STR_64K,
  wsUrl: STR_64K,
  centralSystemUrl: STR_64K.optional(),
  soapCallbackUrl: STR_64K.optional(),
  soapPath: STR_64K.optional(),
  ocppVersion: STR_64K.optional(),
  connectors: z.number().int().min(1).optional(),
  vendor: STR_64K.optional(),
  model: STR_64K.optional(),
  securityProfile: z
    .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
    .optional(),
  authorizationKey: STR_64K.optional(),
  cpoName: STR_64K.optional(),
  tlsCaPath: STR_64K.optional(),
  tlsCertPath: STR_64K.optional(),
  tlsKeyPath: STR_64K.optional(),
  tls: z
    .object({
      ca: STR_64K.optional(),
      cert: STR_64K.optional(),
      key: STR_64K.optional(),
      rejectUnauthorized: z.boolean().optional(),
      serverName: STR_64K.optional(),
    })
    .optional(),
  bootNotification: OBJ().nullable().optional(),
});

const scenarioTemplateInfoSchema = z.object({
  id: STR_64K,
  name: STR_64K,
  description: STR_64K,
});

const connectorSettingsParamsSchema = z.object({
  cpId: STR_64K,
  connectorId: CONN_POS,
});

/** create CP — password is accepted here as WRITE-ONLY input. */
const createParamsSchema = cpParamsBaseSchema.extend({
  basicAuth: z
    .object({ username: STR_64K, password: STR_64K })
    .nullable()
    .optional(),
});

/** update CP — redacted snapshots may omit password; server preserves it. */
const updateParamsSchema = cpParamsBaseSchema.extend({
  basicAuth: z
    .object({ username: STR_64K, password: STR_64K.optional() })
    .nullable()
    .optional(),
});

export const METHODS = {
  // -- lifecycle --
  connect: { params: EMPTY, result: ANY },
  disconnect: { params: EMPTY, result: ANY },
  status: { params: EMPTY, result: statusWireSchema },
  heartbeat: { params: EMPTY, result: ANY },
  start_heartbeat: {
    params: z.object({ interval: z.number().positive() }),
    result: ANY,
  },
  stop_heartbeat: { params: EMPTY, result: ANY },

  // -- transactions --
  start_transaction: {
    params: z.object({ connector: CONN_POS, tagId: STR_64K }),
    result: ANY,
  },
  stop_transaction: { params: z.object({ connector: CONN_POS }), result: ANY },
  authorize: { params: z.object({ tagId: STR_64K }), result: ANY },

  // -- status notifications --
  diagnostics_status_notification: {
    params: z.object({ status: STR_64K }),
    result: ANY,
  },
  firmware_status_notification: {
    params: z.object({ status: STR_64K }),
    result: ANY,
  },
  security_event_notification: {
    params: z.object({ type: STR_64K, techInfo: STR_64K.optional() }),
    result: ANY,
  },
  sign_certificate: {
    params: z.object({ csr: STR_64K.optional() }),
    result: ANY,
  },

  // -- connector --
  update_connector_status: {
    params: z.object({
      connector: CONN_NONNEG,
      status: STR_64K,
      errorCode: STR_64K.optional(),
      info: STR_64K.optional(),
      vendorErrorCode: STR_64K.optional(),
      vendorId: STR_64K.optional(),
      timestamp: STR_64K.optional(),
      suppressChargingStateTransactionEvent: z.boolean().optional(),
    }),
    result: ANY,
  },
  set_meter_value: {
    params: z.object({ connector: CONN_POS, value: z.number().int().min(0) }),
    result: ANY,
  },
  send_meter_value: { params: z.object({ connector: CONN_POS }), result: ANY },
  remove_connector: { params: z.object({ connector: CONN_POS }), result: ANY },
  set_ev_settings: {
    params: z.object({ connector: CONN_POS, settings: OBJ() }),
    result: ANY,
  },
  get_ev_settings: { params: z.object({ connector: CONN_POS }), result: ANY },
  set_auto_meter_config: {
    params: z.object({ connector: CONN_POS, config: OBJ() }),
    result: ANY,
  },
  get_auto_meter_config: {
    params: z.object({ connector: CONN_POS }),
    result: ANY,
  },
  set_auto_reset_to_available: {
    params: z.object({ connector: CONN_POS, enabled: z.boolean() }),
    result: ANY,
  },
  set_mode: {
    params: z.object({ connector: CONN_POS, mode: STR_64K }),
    result: ANY,
  },
  set_soc: {
    params: z.object({ connector: CONN_POS, soc: z.number().nullable() }),
    result: ANY,
  },
  set_soc_meter_sync: {
    params: z.object({ connector: CONN_POS, enabled: z.boolean() }),
    result: ANY,
  },
  get_charging_profiles: {
    params: z.object({ connector: CONN_POS }),
    result: ANY,
  },

  // -- history --
  get_state_history: {
    params: z.object({ options: OBJ().optional() }),
    result: ANY,
  },

  // -- scenarios --
  list_scenario_templates: { params: EMPTY, result: ANY },
  load_scenario_template: {
    params: z.object({
      connector: CONN_POS,
      templateId: STR_64K,
      evSettings: OBJ().optional(),
    }),
    result: ANY,
  },
  load_scenario: {
    params: z.object({
      connector: CONN_POS,
      file: STR_64K.optional(),
      scenario: SCENARIO_OBJ().optional(),
    }),
    result: ANY,
  },
  list_scenarios: { params: z.object({ connector: CONN_POS }), result: ANY },
  run_scenario: {
    params: z.object({ connector: CONN_POS, scenarioId: STR_64K }),
    result: ANY,
  },
  run_scenario_file: {
    params: z.object({ connector: CONN_POS, file: STR_64K }),
    result: ANY,
  },
  run_scenario_template: {
    params: z.object({
      connector: CONN_POS,
      templateId: STR_64K,
      evSettings: OBJ().optional(),
    }),
    result: ANY,
  },
  scenario_status: {
    params: z.object({ connector: CONN_POS, scenarioId: STR_64K }),
    result: ANY,
  },
  // #179 Phase 3: the machine-readable per-run certification report
  // (verdict + assertion results + correlated transcript + state snapshots).
  // runId omitted → latest run for the scenario. `format` is single-valued
  // for now (JUnit is a later phase); kept as an enum so adding it is trivial.
  scenario_report: {
    params: z.object({
      connector: CONN_POS,
      scenarioId: STR_64K,
      runId: STR_64K.optional(),
      format: z.enum(["json"]).optional(),
    }),
    result: ANY,
  },
  get_scenario: {
    params: z.object({ connector: CONN_POS, scenarioId: STR_64K }),
    result: ANY,
  },
  stop_scenario: {
    params: z.object({ connector: CONN_POS, scenarioId: STR_64K }),
    result: ANY,
  },
  step_scenario: {
    params: z.object({
      connector: CONN_POS,
      scenarioId: STR_64K,
      force: z.boolean().optional(),
    }),
    result: ANY,
  },
  stop_all_scenarios: {
    params: z.object({ connector: CONN_POS }),
    result: ANY,
  },
  remove_scenario: {
    params: z.object({ connector: CONN_POS, scenarioId: STR_64K }),
    result: ANY,
  },

  // -- explicit non-jsonMode ops (~10) --
  "cp.list": { params: EMPTY, result: ARRAY_1000(cpListItemSchema) },
  "cp.create": { params: createParamsSchema, result: ANY },
  "cp.update": { params: updateParamsSchema, result: ANY },
  "cp.delete": { params: z.object({ cpId: STR_64K }), result: ANY },
  "logs.get": {
    params: z.object({
      cpId: STR_64K,
      limit: z.number().int().positive().optional(),
    }),
    result: ANY,
  },
  "logs.clear": { params: z.object({ cpId: STR_64K }), result: ANY },
  "state.reset": { params: EMPTY, result: ANY },
  "config.get": {
    params: EMPTY,
    result: wireSimulatorConfigSchema.nullable(),
  },
  "config.save": {
    params: z.object({ config: simulatorConfigInputSchema.nullable() }),
    result: z.object({ ok: z.literal(true) }),
  },
  "scenario.templates": {
    params: EMPTY,
    result: ARRAY_1000(scenarioTemplateInfoSchema),
  },
  "scenario.definitions.list": {
    params: z.object({ cpId: STR_64K, connectorId: CONN_DEF }),
    result: ARRAY_1000(SCENARIO_OBJ()),
  },
  "scenario.definitions.save": {
    params: z.object({
      cpId: STR_64K,
      connectorId: CONN_DEF,
      definition: SCENARIO_OBJ(),
    }),
    result: SCENARIO_OBJ(),
  },
  "scenario.definitions.replace": {
    params: z.object({
      cpId: STR_64K,
      connectorId: CONN_DEF,
      definitions: ARRAY_1000(SCENARIO_OBJ()),
    }),
    result: ARRAY_1000(SCENARIO_OBJ()),
  },
  "scenario.definitions.delete": {
    params: z.object({
      cpId: STR_64K,
      connectorId: CONN_DEF,
      definitionId: STR_64K,
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  "connector_settings.auto_meter.get": {
    params: connectorSettingsParamsSchema,
    result: OBJ().nullable(),
  },
  "connector_settings.auto_meter.save": {
    params: connectorSettingsParamsSchema.extend({ config: OBJ() }),
    result: z.object({ ok: z.literal(true) }),
  },
  "connector_settings.soc_meter_sync.get": {
    params: connectorSettingsParamsSchema,
    result: z.boolean(),
  },
  "connector_settings.soc_meter_sync.save": {
    params: connectorSettingsParamsSchema.extend({ enabled: z.boolean() }),
    result: z.object({ ok: z.literal(true) }),
  },
  // Daemon-wide (not per-CP): pushes Default EV Settings onto every
  // connector of every registered CP, unless a connector currently has an
  // explicit/scenario override active (#105). Distinct from the per-CP
  // `set_ev_settings`, which always marks an override.
  "ev_settings.apply_default": {
    params: z.object({ settings: OBJ() }),
    result: ANY,
  },
  "server.shutdown": { params: EMPTY, result: ANY },
  "events.subscribe": {
    params: z.object({ scope: STR_64K }),
    result: subscribeResultSchema,
  },
  "events.unsubscribe": { params: z.object({ scope: STR_64K }), result: ANY },
} satisfies Record<string, { params: z.ZodTypeAny; result: z.ZodTypeAny }>;

/** The explicit (non-jsonMode) op ids — routed to dedicated server handlers. */
export const EXPLICIT_METHODS = [
  "cp.list",
  "cp.create",
  "cp.update",
  "cp.delete",
  "logs.get",
  "logs.clear",
  "state.reset",
  "config.get",
  "config.save",
  "scenario.templates",
  "scenario.definitions.list",
  "scenario.definitions.save",
  "scenario.definitions.replace",
  "scenario.definitions.delete",
  "connector_settings.auto_meter.get",
  "connector_settings.auto_meter.save",
  "connector_settings.soc_meter_sync.get",
  "connector_settings.soc_meter_sync.save",
  "ev_settings.apply_default",
  "server.shutdown",
  "events.subscribe",
  "events.unsubscribe",
] as const;
