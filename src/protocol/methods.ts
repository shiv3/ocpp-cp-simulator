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
  CP_CREATE_MANY_MAX,
  STR_256,
  STR_1K,
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
/**
 * A scenario definition that is actually loadable: bounded, plus the fields the
 * runtime keys on. `load_scenario` used to take a free-form bounded object, so a
 * payload with no `id` was accepted and stored under the key `undefined` —
 * reported back as `{}` instead of `{ scenarioId }`, and left in
 * `list_scenarios` as an entry that could be neither run nor removed.
 *
 * Failing here is what turns that into a proper `invalid_params` for both
 * Socket.IO and MCP (see dispatchRpc's params.safeParse). An intersection keeps
 * the byte bound and stays permissive about unknown keys — real editor exports
 * carry xyflow UI fields. `CLIChargePointService.loadScenario` re-checks the
 * same invariants for the paths that never see this schema (`file`, the startup
 * loaders). Full schema conformance remains advisory (issue #214).
 */
const LOADABLE_SCENARIO_OBJ = () =>
  z.intersection(
    SCENARIO_OBJ(),
    z.object({
      id: STR_64K.min(1),
      name: STR_64K,
      targetType: z.enum(["chargePoint", "connector"]),
      nodes: z.array(z.unknown()),
      edges: z.array(z.unknown()),
    }),
  );

/**
 * Every field `cp.create` / `cp.update` accept, described in place.
 *
 * The descriptions are here rather than at a call site because the MCP
 * `cp_create` tool builds its input schema from this object (#284). It used
 * to declare its own eight-field copy, which drifted: an agent could not
 * create a SOAP charge point at all, and `securityProfile` /
 * `authorizationKey` were silently dropped — the tool answered success and
 * the station authenticated differently from what was asked. Deriving the
 * tool from this schema is what stops the two from disagreeing again.
 */
const cpParamsBaseSchema = z.object({
  cpId: STR_64K.describe("Charge point identifier"),
  wsUrl: z
    .union([STR_64K, ARRAY_1000(STR_64K).min(1)])
    .describe(
      "CSMS endpoint: ws(s):// for OCPP-J, http(s):// for the SOAP versions. OCPP-J may pass several, and urlDistribution picks between them",
    ),
  idTagPool: z
    .object({
      tags: ARRAY_1000(STR_256.min(1))
        .min(1)
        .optional()
        .describe("Inline idTags"),
      file: STR_1K.optional().describe(
        "Path to a JSON file holding a string array of idTags, read once at creation",
      ),
      distribution: z
        .enum(["round-robin", "random", "connector-affinity"])
        .optional()
        .describe(
          '"round-robin" (default), "random" (seeded by the cpId, so a run replays), or "connector-affinity" (a connector always presents the same tag)',
        ),
    })
    .refine((v) => (v.tags === undefined) !== (v.file === undefined), {
      message: "idTagPool needs exactly one of tags or file",
    })
    .optional()
    .describe(
      "idTags this charge point draws from when a call names none. An explicit tagId always wins",
    ),
  urlDistribution: z
    .enum(["round-robin", "random", "cp-affinity"])
    .optional()
    .describe(
      'How a multi-URL charge point picks one: "round-robin" (default) moves on every attempt, "random" draws from a seeded stream, "cp-affinity" hashes the cpId to a primary and stays on it until it fails repeatedly',
    ),
  centralSystemUrl: STR_64K.optional().describe(
    "SOAP only: the Central System service URL, when it differs from wsUrl",
  ),
  soapCallbackUrl: STR_64K.optional().describe(
    "SOAP only: the full public URL the CSMS calls back on, e.g. http://host:9700/ocpp/soap/<cpId>/ChargePointService",
  ),
  soapPath: STR_64K.optional().describe(
    "SOAP only: path prefix this daemon serves the ChargePointService under (default /ocpp/soap)",
  ),
  ocppVersion: STR_64K.optional().describe(
    'OCPP version: "OCPP-1.6J" (default), "OCPP-2.0.1", "OCPP-2.1", "OCPP-1.2", "OCPP-1.5", or "OCPP-1.6S"',
  ),
  connectors: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Number of connectors"),
  vendor: STR_64K.optional().describe("Vendor name"),
  model: STR_64K.optional().describe("Model name"),
  securityProfile: z
    .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
    .optional()
    .describe(
      "OCPP 1.6 security profile. 0 leaves transport/auth as configured; 1 adds AuthorizationKey Basic Auth and keeps the configured scheme; 2/3 require wss://. Profiles 1 and 2 need authorizationKey",
    ),
  authorizationKey: STR_64K.optional().describe(
    "AuthorizationKey used as the Basic Auth password for security profiles 1 and 2 (the username is the cpId)",
  ),
  cpoName: STR_64K.optional().describe(
    "CPO name used when generating certificate signing requests",
  ),
  tlsCaPath: STR_64K.optional().describe(
    "Path to a PEM CA bundle verifying the CSMS certificate. Omit to use the system trust store; passing one REPLACES the default roots",
  ),
  tlsCertPath: STR_64K.optional().describe(
    "Path to the PEM client certificate for security profile 3 mutual TLS",
  ),
  tlsKeyPath: STR_64K.optional().describe(
    "Path to the PEM client private key for security profile 3 mutual TLS",
  ),
  tls: z
    .object({
      ca: STR_64K.optional().describe("CA bundle, inline PEM"),
      cert: STR_64K.optional().describe("Client certificate, inline PEM"),
      key: STR_64K.optional().describe("Client private key, inline PEM"),
      rejectUnauthorized: z
        .boolean()
        .optional()
        .describe(
          "Defaults to true. Setting it false disables certificate verification and logs a warning; local development only",
        ),
      serverName: STR_64K.optional().describe("SNI server name override"),
    })
    .optional()
    .describe("Inline TLS material, as an alternative to the tls*Path fields"),
  bootNotification: OBJ()
    .nullable()
    .optional()
    .describe("Overrides for the BootNotification payload"),
  // Honoured by `createCp` and `updateCp` since long before it was declared:
  // both read it straight off the raw params, so it worked over socket.io yet
  // appeared in no schema, which is why the MCP tool had to re-add it by hand.
  // On the shared base rather than on `cp.create` alone, so `list_methods`
  // advertises it for `cp.update` too — that method honours it as a reconnect.
  autoConnect: z
    .boolean()
    .optional()
    .describe(
      "Connect to the CSMS immediately after the call (cp.update reconnects)",
    ),
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
export const createParamsSchema = cpParamsBaseSchema.extend({
  basicAuth: z
    .object({
      username: STR_64K.describe("Basic auth username"),
      password: STR_64K.describe("Basic auth password"),
    })
    .nullable()
    .optional()
    .describe(
      "Basic auth credentials for the CSMS link. Prefer securityProfile + authorizationKey for OCPP 1.6 security profiles",
    ),
});

/**
 * `{n}` / `{n:0W}` — the only substitution `idPattern` performs. Deliberately
 * not a template language: one index placeholder, optionally zero-padded to a
 * fixed width, is what generated station ids need, and anything richer becomes
 * a parser to maintain and a surface to escape.
 *
 * The width is capped at two digits on purpose. An unbounded one lets a
 * schema-valid `{n:065537}` expand past `STR_64K` — the charge point would be
 * created (`parseCreateBody` only asks that the id be non-empty) and then the
 * result validation would fail, reporting an internal error over a side effect
 * that already happened. It also invites a padStart allocation chosen by the
 * caller. 99 characters of zero-padding is far past any real station id.
 */
const ID_PATTERN_PLACEHOLDER = /\{n(?::0(\d{1,2}))?\}/;

/**
 * Bulk creation. Derived from `createParamsSchema` rather than restating it —
 * the same rule #284 established for the MCP tool. `cpId` is dropped because
 * `idPattern` generates it; everything else, SOAP and security fields
 * included, is shared by every charge point in the batch.
 */
export const createManyParamsSchema = createParamsSchema
  .omit({ cpId: true })
  .extend({
    count: z
      .number()
      .int()
      .min(1)
      .max(CP_CREATE_MANY_MAX)
      .describe(`How many charge points to create (1..${CP_CREATE_MANY_MAX})`),
    idPattern: STR_64K.refine((v) => ID_PATTERN_PLACEHOLDER.test(v), {
      message:
        "idPattern must contain {n} or {n:0W} with W at most 2 digits, e.g. CP{n:03}",
    }).describe(
      'Charge point id template. "{n}" is the index; "{n:03}" zero-pads it to width 3, so CP{n:03} yields CP001, CP002, …',
    ),
    startIndex: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("First index substituted into idPattern (default 1)"),
  });

/**
 * Whether a string carries an index placeholder. Used to refuse a batch whose
 * SOAP callback URL would be identical for every charge point in it.
 */
export function hasIdPatternPlaceholder(value: string): boolean {
  return ID_PATTERN_PLACEHOLDER.test(value);
}

/**
 * Longest generated charge point id.
 *
 * The pad-width cap alone does not bound the result: a pattern may repeat the
 * placeholder, and `"{n:99}".repeat(1000)` is 6 KB of schema-valid input that
 * expands to a 99 KB id. `parseCreateBody` only asks that an id be non-empty,
 * so the charge point would be registered and only then would the result fail
 * to validate — an internal error reported over a side effect that already
 * happened, times `count`. 256 matches the `cpId` cap the rpc envelope already
 * enforces.
 */
export const MAX_GENERATED_CP_ID_LENGTH = 256;

/** Expand `idPattern` for one index. Shared by the server and its tests. */
export function expandIdPattern(pattern: string, index: number): string {
  return pattern.replace(
    new RegExp(ID_PATTERN_PLACEHOLDER, "g"),
    (_match, width: string | undefined) =>
      width === undefined
        ? String(index)
        : String(index).padStart(Number(width), "0"),
  );
}

/** update CP — redacted snapshots may omit password; server preserves it. */
const updateParamsSchema = cpParamsBaseSchema.extend({
  basicAuth: z
    .object({ username: STR_64K, password: STR_64K.optional() })
    .nullable()
    .optional(),
});

/**
 * A named, reusable charge point description — the *hardware* half, where a
 * scenario is the *behaviour* half. The two compose: instantiate a blueprint,
 * then load a scenario onto a connector; neither needs to know about the other.
 *
 * `params` is the `cp.create` block minus `cpId`, which `cp.create_many`
 * generates. Derived from `createManyParamsSchema` rather than restated, and
 * without the batch fields — a blueprint says what a charge point *is*, not
 * how many of them to make.
 */
export const blueprintSchema = z.object({
  // `.min(1)`: an empty id would store a blueprint that `blueprint.delete`
  // refuses to accept, leaving it undeletable through the API.
  id: STR_256.min(1).describe("Blueprint identifier, unique within the daemon"),
  name: STR_256.min(1).describe("Human-readable name"),
  description: STR_1K.optional().describe("What this hardware profile is"),
  params: createManyParamsSchema
    .omit({ count: true, idPattern: true, startIndex: true })
    // `wsUrl` is optional here and required at instantiation. A blueprint
    // describes hardware; the CSMS a fleet points at is a property of the run,
    // which is why the built-in profiles carry no URL at all. `cp.create_many`
    // validates the merged result against `createManyParamsSchema`, so a
    // blueprint without one still cannot produce a charge point without one.
    .partial({ wsUrl: true })
    .describe("The cp.create parameter block, minus the generated cpId"),
  evSettings: OBJ()
    .optional()
    .describe("Default EV settings applied to every connector"),
  scenarioTemplateId: STR_256.optional().describe(
    "Scenario template loaded onto each connector after creation",
  ),
});

export type Blueprint = z.infer<typeof blueprintSchema>;

/**
 * The flattened shape for schema-driven clients (the MCP tool, `list_methods`).
 *
 * Every field with `wsUrl` optional, so `blueprintId` is visible rather than
 * hidden behind a union branch. `createManyFromBlueprintSchema` adds the
 * refinement that one of the two must be present.
 */
export const createManyToolSchema = createManyParamsSchema
  // `idPattern` joins `wsUrl` in being optional: `{ blueprintId, count }`
  // otherwise failed validation before the handler could default it.
  .partial({ wsUrl: true, idPattern: true })
  .extend({
    blueprintId: STR_256.min(1)
      .optional()
      .describe(
        "Blueprint to instantiate. Any parameter given alongside it overrides the blueprint's. Either this or wsUrl is required",
      ),
  });

/**
 * `cp.create_many` accepts either an explicit parameter block or a blueprint
 * id, so `wsUrl` cannot simply be required. A union rather than an
 * all-optional object: the latter would accept a call naming neither and fail
 * later, inside the loop, after some charge points already existed.
 */
/**
 * `cp.create_many` accepts either an explicit parameter block or a blueprint
 * id, so `wsUrl` cannot simply be required.
 *
 * One object with a refinement, **not** a union. A union's first matching
 * branch wins and unknown properties are stripped, so
 * `{ blueprintId, wsUrl, count, idPattern }` matched the explicit branch and
 * lost `blueprintId` silently — the batch came up with the caller's URL and
 * none of the blueprint's hardware, reporting success. The refinement keeps
 * every field and still refuses a call naming neither source, before anything
 * is created.
 */
export const createManyFromBlueprintSchema = createManyToolSchema.refine(
  (value) => value.wsUrl !== undefined || value.blueprintId !== undefined,
  { message: "either wsUrl or blueprintId is required" },
);

export const METHODS = {
  // -- lifecycle --
  connect: { params: EMPTY, result: ANY },
  disconnect: { params: EMPTY, result: ANY },
  reset: { params: EMPTY, result: ANY },
  status: { params: EMPTY, result: statusWireSchema },
  heartbeat: { params: EMPTY, result: ANY },
  start_heartbeat: {
    params: z.object({ interval: z.number().positive() }),
    result: ANY,
  },
  stop_heartbeat: { params: EMPTY, result: ANY },

  // -- transactions --
  start_transaction: {
    // `tagId` is optional since #299: without one the charge point draws from
    // its idTag pool, and falls back to the historical literal if it has none.
    params: z.object({ connector: CONN_POS, tagId: STR_64K.optional() }),
    result: ANY,
  },
  stop_transaction: { params: z.object({ connector: CONN_POS }), result: ANY },
  authorize: { params: z.object({ tagId: STR_64K.optional() }), result: ANY },

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
      scenario: LOADABLE_SCENARIO_OBJ().optional(),
    }),
    result: ANY,
  },
  list_scenarios: { params: z.object({ connector: CONN_POS }), result: ANY },
  run_scenario: {
    params: z.object({
      connector: CONN_POS,
      scenarioId: STR_64K,
      strict: z.boolean().optional(),
      // Opt-in: block the RPC response until the run has either parked on
      // its first expectation (armed — e.g. a RemoteStartTransaction
      // trigger) or ended without ever parking, instead of returning the
      // instant the run is kicked off. Closes the run_scenario /
      // CSMS-command race for a caller that fires the CSMS-initiated call
      // right after run_scenario returns and needs to know the scenario is
      // actually listening first — see CLIChargePointService.waitForScenarioArmed.
      awaitArmed: z.boolean().optional(),
    }),
    result: ANY,
  },
  run_scenario_file: {
    params: z.object({
      connector: CONN_POS,
      file: STR_64K,
      strict: z.boolean().optional(),
    }),
    result: ANY,
  },
  run_scenario_template: {
    params: z.object({
      connector: CONN_POS,
      templateId: STR_64K,
      evSettings: OBJ().optional(),
      strict: z.boolean().optional(),
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
  scenario_reset: {
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

  // -- network simulation --
  "network_sim.global.get": { params: EMPTY, result: ANY },
  "network_sim.global.save": {
    params: z.object({ config: boundedObject(OBJ_MAX_BYTES).nullable() }),
    result: ANY,
  },
  "network_sim.cp.get": {
    params: z.object({ cpId: STR_64K }),
    result: ANY,
  },
  "network_sim.cp.save": {
    params: z.object({
      cpId: STR_64K,
      config: boundedObject(OBJ_MAX_BYTES).nullable(),
    }),
    result: ANY,
  },
  "network_sim.disconnect.trigger": {
    params: z.object({ cpId: STR_64K, ruleId: STR_64K }),
    result: ANY,
  },

  // -- explicit non-jsonMode ops (~10) --
  "cp.list": { params: EMPTY, result: ARRAY_1000(cpListItemSchema) },
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
    params: z.object({ id: STR_256 }),
    result: z.object({ ok: z.literal(true) }),
  },
  "cp.create_many": {
    params: createManyFromBlueprintSchema,
    result: z.object({
      created: ARRAY_1000(STR_64K),
      failed: ARRAY_1000(z.object({ cpId: STR_64K, reason: STR_64K })),
    }),
  },
  "cp.update": { params: updateParamsSchema, result: ANY },
  "cp.delete": { params: z.object({ cpId: STR_64K }), result: ANY },
  // `limit` selects the NEWEST n entries (tail), not the oldest -- it used to
  // be the oldest, which made the parameter useless on a charge point that had
  // been up for days. `offset` pages backwards from the newest; `order`
  // controls the direction of the returned window ("asc" = oldest first).
  "logs.get": {
    params: z.object({
      cpId: STR_64K,
      limit: z.number().int().positive().optional(),
      offset: z.number().int().min(0).optional(),
      order: z.enum(["asc", "desc"]).optional(),
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
  "cp.create_many",
  "blueprint.list",
  "blueprint.save",
  "blueprint.delete",
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
  "network_sim.global.get",
  "network_sim.global.save",
  "network_sim.cp.get",
  "network_sim.cp.save",
  "network_sim.disconnect.trigger",
] as const;
