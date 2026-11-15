import { z } from "zod";
import { ARRAY_1000, STR_256, STR_64K } from "../limits";
import {
  cpListItemSchema,
  simulatorConfigInputSchema,
  wireSimulatorConfigSchema,
} from "../events";
import { subscribeResultSchema } from "../envelope";
import { labelsSchema } from "../labels";
import { CHARGING_SESSION_OUTCOMES } from "../chargingSession";
import { SCENARIO_RUN_EXECUTION_STATES, SCENARIO_VERDICTS } from "../scenario";
import {
  TIMELINE_DEFAULT_CAPACITY,
  TIMELINE_FORMAT_VERSION,
  TIMELINE_KINDS,
} from "../timeline";
import {
  CONN_POS,
  CONN_DEF,
  EMPTY,
  STOP_ON_CLOSE,
  NON_EMPTY_STR,
  ANY,
  SCENARIO_RUNS_PAGE_MAX,
  CHARGING_SESSIONS_PAGE_MAX,
  ISO_INSTANT,
  chargingSessionSchema,
  CONFIG_KEY_SET_STATUSES,
  configKeyInfoSchema,
  timelineEntrySchema,
  OBJ,
  SCENARIO_OBJ,
} from "../schemas/common";
import {
  scenarioTemplateInfoSchema,
  connectorSettingsParamsSchema,
  createParamsSchema,
  cpListParamsSchema,
  cpLabelsSetParamsSchema,
  cpBehaviorsSetParamsSchema,
  behaviorListResultSchema,
  behaviorReloadParamsSchema,
  behaviorReloadResultSchema,
  cpBulkParamsSchema,
  cpBulkResultSchema,
  cpScenarioRunParamsSchema,
  cpScenarioRunResultSchema,
  updateParamsSchema,
} from "../schemas/cp";
import {
  blueprintSchema,
  fleetTemplateSchema,
  fleetCreateParamsSchema,
  fleetCreateResultSchema,
  serverInfoSchema,
  createManyFromBlueprintSchema,
} from "../schemas/fleet";

export const DAEMON_METHODS = {
  "cp.list": {
    params: cpListParamsSchema,
    result: ARRAY_1000(cpListItemSchema),
  },
  "cp.create": { params: createParamsSchema, result: ANY },
  // Partial success is the result, not an error: one unreachable CSMS URL must
  // not roll back the charge points that came up fine, so failures are
  // reported per id instead of thrown.
  // The result carries the built-ins as well as the stored ones, so the cap
  // has to leave room for them — `blueprint.save` enforces the matching
  // ceiling on stored blueprints rather than letting the list outgrow this.
  "blueprint.list": { params: EMPTY, result: ARRAY_1000(blueprintSchema) },
  "blueprint.save": {
    params: z.object({ blueprint: blueprintSchema }),
    result: z.object({ id: STR_256 }),
  },
  "blueprint.delete": {
    // `.min(1)` like `blueprintSchema.id`: an empty id names no blueprint.
    params: z.object({ id: STR_256.min(1) }),
    result: z.object({ ok: z.literal(true) }),
  },
  "cp.create_many": {
    params: createManyFromBlueprintSchema,
    result: z.object({
      created: ARRAY_1000(STR_64K),
      failed: ARRAY_1000(z.object({ cpId: STR_64K, reason: STR_64K })),
    }),
  },
  "fleet.template.list": {
    params: EMPTY,
    result: ARRAY_1000(fleetTemplateSchema),
  },
  "fleet.template.get": {
    params: z.object({ id: STR_256.min(1) }),
    result: fleetTemplateSchema,
  },
  "fleet.template.save": {
    params: z.object({ template: fleetTemplateSchema }),
    result: z.object({ id: STR_256 }),
  },
  "fleet.template.delete": {
    params: z.object({ id: STR_256.min(1) }),
    result: z.object({ ok: z.literal(true) }),
  },
  // Partial success is the result, like `cp.create_many`.
  "fleet.create": {
    params: fleetCreateParamsSchema,
    result: fleetCreateResultSchema,
  },
  "cp.update": { params: updateParamsSchema, result: ANY },
  "cp.delete": {
    params: z.object({ cpId: NON_EMPTY_STR, ...STOP_ON_CLOSE }),
    result: ANY,
  },
  "cp.labels.set": {
    params: cpLabelsSetParamsSchema,
    result: z.object({ cpId: STR_64K }),
  },
  "cp.behaviors.set": {
    params: cpBehaviorsSetParamsSchema,
    result: z.object({
      cpId: STR_64K,
      /** The ids the charge point runs now. */
      behaviors: ARRAY_1000(STR_256),
    }),
  },
  "behavior.list": {
    params: z.object({}).strict(),
    result: behaviorListResultSchema,
  },
  "behavior.reload": {
    params: behaviorReloadParamsSchema,
    result: behaviorReloadResultSchema,
  },
  // #470: partial success is the result, like `cp.create_many`: every
  // selected id is in `matched`, then in exactly one of the other two.
  "cp.bulk": { params: cpBulkParamsSchema, result: cpBulkResultSchema },
  // #486: `cp.bulk`'s selector, a scenario template instead of an action.
  "cp.scenario.run": {
    params: cpScenarioRunParamsSchema,
    result: cpScenarioRunResultSchema,
  },
  // `limit` selects the NEWEST n entries (tail), not the oldest -- it used to
  // be the oldest, which made the parameter useless on a charge point that had
  // been up for days. `offset` pages backwards from the newest; `order`
  // controls the direction of the returned window ("asc" = oldest first).
  "logs.get": {
    params: z.object({
      cpId: NON_EMPTY_STR,
      limit: z.number().int().positive().optional(),
      offset: z.number().int().min(0).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    }),
    result: ANY,
  },
  "logs.clear": { params: z.object({ cpId: NON_EMPTY_STR }), result: ANY },
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
  // #388: the daemon's finished runs across charge points, newest first by
  // start time. Summaries only — `scenario_report` returns one run's full
  // report. Every filter is an exact match; `total` counts the filtered runs
  // before paging.
  "scenario.runs.list": {
    params: z.object({
      runId: NON_EMPTY_STR.optional(),
      cpId: NON_EMPTY_STR.optional(),
      connectorId: CONN_POS.optional(),
      scenarioId: NON_EMPTY_STR.optional(),
      verdict: z.enum(SCENARIO_VERDICTS).optional(),
      executionState: z.enum(SCENARIO_RUN_EXECUTION_STATES).optional(),
      limit: z.number().int().min(1).max(SCENARIO_RUNS_PAGE_MAX).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    result: z.object({
      runs: z.array(ANY).max(SCENARIO_RUNS_PAGE_MAX),
      total: z.number().int().min(0),
    }),
  },
  // #448: a charge point's operational timeline, windowed like `logs.get`
  // (`limit` = newest N, `offset` pages back, `order` of the window). Every
  // filter is an exact match; `total` counts the filtered entries before
  // windowing. Kinds and correlation rules: docs/concepts/operational-timeline.md.
  "timeline.get": {
    params: z.object({
      cpId: NON_EMPTY_STR,
      connectorId: CONN_POS.optional(),
      runId: NON_EMPTY_STR.optional(),
      incidentId: NON_EMPTY_STR.optional(),
      kinds: z
        .array(z.enum(TIMELINE_KINDS))
        .min(1)
        .max(TIMELINE_KINDS.length)
        .optional(),
      limit: z.number().int().min(1).max(TIMELINE_DEFAULT_CAPACITY).optional(),
      offset: z.number().int().min(0).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    }),
    result: z.object({
      version: z.literal(TIMELINE_FORMAT_VERSION),
      entries: z.array(timelineEntrySchema).max(TIMELINE_DEFAULT_CAPACITY),
      total: z.number().int().min(0),
    }),
  },
  // #489: `cpId` omitted lists across every charge point (like
  // `scenario.runs.list`), newest start first, ties by record order. `labels`
  // narrows a fleet-wide listing to a selector (`{}` = all, as in `cp.list`);
  // `startedFrom` (inclusive) / `startedTo` (exclusive) bound the start time.
  "sessions.list": {
    params: z.object({
      cpId: NON_EMPTY_STR.optional(),
      labels: labelsSchema.optional(),
      startedFrom: ISO_INSTANT.optional(),
      startedTo: ISO_INSTANT.optional(),
      connectorId: CONN_POS.optional(),
      outcomes: z
        .array(z.enum(CHARGING_SESSION_OUTCOMES))
        .min(1)
        .max(CHARGING_SESSION_OUTCOMES.length)
        .optional(),
      limit: z.number().int().min(1).max(CHARGING_SESSIONS_PAGE_MAX).optional(),
      offset: z.number().int().min(0).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    }),
    result: z.object({
      sessions: z.array(chargingSessionSchema).max(CHARGING_SESSIONS_PAGE_MAX),
      total: z.number().int().min(0),
    }),
  },
  // #612: a running charge point's OCPP configuration keys (1.6 keys; for 2.x
  // the keys the Device Model registry registers). `cp.config_keys.set` fails
  // with `not_found` for a key the charge point does not have and
  // `invalid_params` for a read-only key or a value the key refuses.
  "cp.config_keys.get": {
    params: z.object({
      cpId: NON_EMPTY_STR,
      /** Key names; absent or empty lists every key. */
      keys: z.array(STR_256.min(1)).max(1000).optional(),
    }),
    result: z.object({
      keys: z.array(configKeyInfoSchema).max(5000),
      unknown: z.array(STR_256).max(1000),
    }),
  },
  "cp.config_keys.set": {
    params: z.object({
      cpId: NON_EMPTY_STR,
      key: STR_256.min(1),
      /** The value as ChangeConfiguration carries it; a list is comma-separated. */
      value: STR_64K,
    }),
    result: z.object({
      key: STR_256,
      status: z.enum(CONFIG_KEY_SET_STATUSES),
    }),
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
  "connector_settings.auto_traffic.get": {
    params: connectorSettingsParamsSchema,
    result: OBJ().nullable(),
  },
  "connector_settings.auto_traffic.save": {
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
  // `set_ev_settings`, which always marks an override. `settings` may be
  // partial: it is merged onto the built-in defaults, so an omitted field
  // reads back as its default (#333).
  "ev_settings.apply_default": {
    params: z.object({ settings: OBJ() }),
    result: ANY,
  },
  "server.shutdown": { params: EMPTY, result: ANY },
  // Daemon-wide facts a client needs before it can shape a request: the
  // SOAP public base (`--soap-public-base-url` or the `--soap-tunnel`
  // origin) that `cp.create` derives a missing callback URL from (#183).
  "server.info": { params: EMPTY, result: serverInfoSchema },
  "events.subscribe": {
    params: z.object({ scope: STR_64K }),
    result: subscribeResultSchema,
  },
  "events.unsubscribe": { params: z.object({ scope: STR_64K }), result: ANY },
} satisfies Record<string, { params: z.ZodTypeAny; result: z.ZodTypeAny }>;
