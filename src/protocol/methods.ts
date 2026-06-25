// The rpc method table — the single typed contract for every client→server
// call. CP-command keys are the jsonMode command ids VERBATIM (identity
// dispatch: the server routes them straight through `handleJsonCommand`).
// The ~10 dotted keys are the non-jsonMode explicit ops.
//
// Connector rule (PB3): only `update_connector_status` accepts connector 0
// (`requireNonNegativeInt`); every other connector-taking command requires
// >= 1 (`requirePositiveInt`). DoS limits (Sec-4) bound every string/array.

import { z } from "zod";

import { ARRAY_1000, STR_64K } from "./limits";
import { cpListItemSchema, statusWireSchema } from "./events";
import { subscribeResultSchema } from "./envelope";

const CONN_POS = z.number().int().min(1);
const CONN_NONNEG = z.number().int().min(0);
const EMPTY = z.object({});
const ANY = z.unknown();
/** A bounded free-form object param (settings/config/options/scenario). */
const OBJ = () => z.record(z.string(), z.unknown());

/** create/update CP — password is accepted here as WRITE-ONLY input. */
const createParamsSchema = z.object({
  cpId: STR_64K,
  wsUrl: STR_64K,
  ocppVersion: STR_64K.optional(),
  connectors: z.number().int().min(1).optional(),
  vendor: STR_64K.optional(),
  model: STR_64K.optional(),
  basicAuth: z
    .object({ username: STR_64K, password: STR_64K })
    .nullable()
    .optional(),
  bootNotification: OBJ().nullable().optional(),
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

  // -- connector --
  update_connector_status: {
    params: z.object({ connector: CONN_NONNEG, status: STR_64K }),
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
      scenario: OBJ().optional(),
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
  "cp.update": { params: createParamsSchema, result: ANY },
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
  "server.shutdown": { params: EMPTY, result: ANY },
  "events.subscribe": {
    params: z.object({ scope: STR_64K }),
    result: subscribeResultSchema,
  },
  "events.unsubscribe": { params: z.object({ scope: STR_64K }), result: ANY },
} satisfies Record<string, { params: z.ZodTypeAny; result: z.ZodTypeAny }>;

/** The 10 explicit (non-jsonMode) op ids — routed to dedicated server handlers. */
export const EXPLICIT_METHODS = [
  "cp.list",
  "cp.create",
  "cp.update",
  "cp.delete",
  "logs.get",
  "logs.clear",
  "state.reset",
  "server.shutdown",
  "events.subscribe",
  "events.unsubscribe",
] as const;
