import { chargerCapabilitiesSchema } from "../chargerCapabilities";
import { z } from "zod";
import {
  ARRAY_1000,
  CP_CREATE_MANY_MAX,
  STR_256,
  STR_1K,
  STR_64K,
  boundedObject,
} from "../limits";
import { labelsSchema } from "../labels";
import { modemConfigSchema } from "../modem";
import { transportConfigSchema } from "../transportConfig";
import {
  CONN_POS,
  NON_EMPTY_STR,
  OBJ,
  behaviorIdsSchema,
  BEHAVIOR_PARAMS_MAX_BYTES,
  behaviorParamsSchema,
} from "./common";

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
export const cpParamsBaseSchema = z.object({
  cpId: NON_EMPTY_STR.describe("Charge point identifier"),
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
        "Path to a JSON file holding a string array of idTags, resolved at creation and re-read on change only when the daemon runs with --watch",
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
  transport: transportConfigSchema
    .optional()
    .describe(
      "Transport settings of this charge point. transport.reconnect sets the reconnect policy (max attempts, fixed or exponential, base and max delay, jitter) and the BootNotification retry limit; omitted fields keep the built-in behaviour",
    ),
  txUpdatedMeterValues: z
    .boolean()
    .optional()
    .describe(
      "OCPP 2.x only: send the periodic meter samples taken during a transaction as TransactionEvent(Updated, MeterValuePeriodic) instead of MeterValues. Defaults to true; false restores the standalone MeterValues",
    ),
  inboundValidation: z
    .enum(["off", "warn", "enforce"])
    .optional()
    .describe(
      "OCPP 1.6J only: what to do with an inbound CALL whose payload breaks the request schema. off skips the check, warn (default) logs and traces the violation and runs the handler, enforce answers a CALLERROR (FormationViolation, OccurenceConstraintViolation, PropertyConstraintViolation or TypeConstraintViolation)",
    ),
  reservationAuthorizeIdTag: z
    .boolean()
    .optional()
    .describe(
      "OCPP 1.6 only: authorize the idTag of a ReserveNow (local rules, then Authorize.req) before accepting it; a tag that is not Accepted answers Rejected. Defaults to false",
    ),
  capabilityProfile: z
    .object({
      disabledActions: z
        .array(STR_256)
        .max(256)
        .optional()
        .describe(
          "CSMS->CP actions this charge point does not implement (e.g. GetCompositeSchedule, ReserveNow). An inbound CALL for one is answered with CALLERROR NotImplemented. On OCPP 2.x a one-to-one action also matches its 1.6 spelling (RemoteStartTransaction for RequestStartTransaction); a folded pair does not (ExtendedTriggerMessage does not disable TriggerMessage)",
        ),
      triggerMessageTargets: z
        .array(STR_256)
        .max(256)
        .optional()
        .describe(
          "The message types TriggerMessage / ExtendedTriggerMessage may request; any other target is answered NotImplemented. On OCPP 2.x the 1.6 spellings DiagnosticsStatusNotification and SignChargePointCertificate also stand for LogStatusNotification and SignChargingStationCertificate. [] supports none. Omit to leave the targets as they are",
        ),
      disabledActionErrorCode: z
        .enum(["NotImplemented", "NotSupported"])
        .optional()
        .describe(
          "The CALLERROR code a disabled action is answered with (OCPP-J 1.6 section 4.2.3): NotImplemented (default, the action is not known) or NotSupported (the action is recognized but not supported)",
        ),
      statusTransitions: z
        .enum(["warn", "enforce"])
        .optional()
        .describe(
          "OCPP 1.6J only: a connector status change the OCPP 1.6 section 4.9 transition table does not list. warn (default) logs it and sends the StatusNotification; enforce changes the connector but does not send the StatusNotification (event statusNotificationSuppressed), unless the change was requested with allowInvalidTransition",
        ),
    })
    .strict()
    .optional()
    .describe(
      "Static capability profile (#618): declare the charge point as lacking features. A scenario inbound policy or response override keeps precedence. Not accepted for the OCPP SOAP versions (their calls bypass the inbound gate). Omit for current behavior",
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
  // #446. On cp.update an omitted map keeps the current labels and a given one
  // replaces it whole; cp.labels.set changes them without rebuilding the CP.
  labels: labelsSchema.optional(),
  behaviors: behaviorIdsSchema.optional(),
  behaviorParams: behaviorParamsSchema.optional(),
  modem: modemConfigSchema
    .optional()
    .describe(
      "Cellular modem and SIM (#928). Omit for no modem model: the BootNotification keeps its static iccid/imsi. State persisted for the id (--state-db) wins over this initial state, so cp.update does not reset a swapped card; use the modem.* methods to change it",
    ),
  chargerCapabilities: chargerCapabilitiesSchema
    .optional()
    .describe(
      "What the charger hardware delivers per connector (#327). The cap narrows the offered and accepted power and the energy register together, whatever the vehicle and the CSMS allow. A connector not listed is uncapped. Omit for no cap; cp.update keeps the current value when omitted",
    ),
});

export const scenarioTemplateInfoSchema = z.object({
  id: STR_64K,
  name: STR_64K,
  description: STR_64K,
});

export const connectorSettingsParamsSchema = z.object({
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
export const ID_PATTERN_PLACEHOLDER = /\{n(?::0(\d{1,2}))?\}/;

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

/**
 * `cp.list` selector (#446): when `labels` is given, only the charge points
 * carrying every one of those `key: value` pairs are returned.
 */
export const cpListParamsSchema = z
  .object({
    labels: labelsSchema
      .optional()
      .describe(
        "Only return charge points carrying every one of these label pairs (exact, case-sensitive match)",
      ),
  })
  .strict();

/**
 * `cp.labels.set` (#446): replaces a charge point's labels in place. Unlike
 * `cp.update` it does not rebuild the charge point, so its connection and any
 * running transaction survive a relabel.
 */
export const cpLabelsSetParamsSchema = z.object({
  cpId: NON_EMPTY_STR.describe("Charge point identifier"),
  labels: labelsSchema.describe(
    "The complete new label map; {} removes every label",
  ),
});

/**
 * `cp.behaviors.set`: change which loaded behaviors a charge point runs, in
 * place (no rebuild, the connection stays). `null` goes back to "every loaded
 * behavior". Only ids; see {@link behaviorIdsSchema}.
 */
export const cpBehaviorsSetParamsSchema = z
  .object({
    cpId: NON_EMPTY_STR.describe("Charge point identifier"),
    behaviors: behaviorIdsSchema
      .nullable()
      .describe(
        "The behavior ids to run; [] runs none, null runs every loaded behavior",
      ),
    behaviorParams: behaviorParamsSchema
      .optional()
      .describe(
        "Params for the behaviors, by id (built-in default.* ids included). The whole selection is replaced: omitted means no params, every behavior runs with its defaults",
      ),
  })
  .strict();

/**
 * What `behavior.list` says about a behavior's params: the schema (a closed
 * JSON Schema subset, see docs/concepts/charger-engine.md) and the defaults
 * that apply when nothing is set.
 */
export const behaviorParamsInfoSchema = z.object({
  schema: boundedObject(BEHAVIOR_PARAMS_MAX_BYTES),
  defaults: boundedObject(BEHAVIOR_PARAMS_MAX_BYTES),
});

/** The library `--behavior` loaded: ids and where each came from. */
export const behaviorListResultSchema = z.object({
  behaviors: ARRAY_1000(
    z.object({
      id: STR_256,
      /** The file it was loaded from, as given on the command line. */
      file: STR_64K.nullable(),
      /** Its params schema and defaults, when it declares params (#654). */
      params: behaviorParamsInfoSchema.optional(),
    }),
  ),
  /** Whether `--watch-behaviors` is on. */
  watching: z.boolean(),
  /**
   * The built-in behaviors every station has, and the CSMS actions each
   * answers: the actions `mode: "extend"` is possible for.
   */
  defaults: ARRAY_1000(
    z.object({
      id: STR_256,
      actions: ARRAY_1000(STR_256),
      /** Its params schema and defaults, when it declares params (#654). */
      params: behaviorParamsInfoSchema.optional(),
    }),
  ),
});

/**
 * `behavior.reload` takes no parameters on purpose: it re-reads the files
 * given on the command line and nothing else, so no path and no code can come
 * from the caller.
 */
export const behaviorReloadParamsSchema = z.object({}).strict();

export const behaviorReloadResultSchema = z.object({
  files: ARRAY_1000(
    z.object({
      file: STR_64K,
      ids: ARRAY_1000(STR_256),
      ok: z.boolean(),
      /** The bundle equals the one in use: nothing was replaced. */
      unchanged: z.boolean(),
      error: STR_64K.optional(),
      /** Charge points now running the new version. */
      applied: z.number().int().min(0),
      /** Charge points that kept the old version, with the reason. */
      failures: ARRAY_1000(STR_64K),
    }),
  ),
});

/** The lifecycle actions `cp.bulk` can run on a label selector (#470). */
export const CP_BULK_ACTIONS = ["connect", "disconnect", "reset"] as const;

/**
 * `cp.bulk` (#470): one lifecycle action on every charge point carrying every
 * pair of `labels`. Unlike `cp.list`, the selector is required and must not be
 * empty: `{}` matches every charge point, and a mutating call that reaches the
 * whole fleet by leaving out a field is too easy to send by mistake.
 */
export const cpBulkParamsSchema = z
  .object({
    labels: labelsSchema
      .refine((labels) => Object.keys(labels).length > 0, {
        message: "at least one label pair is required",
      })
      .describe(
        "Act on the charge points carrying every one of these label pairs (exact, case-sensitive match). At least one pair; {} is refused",
      ),
    action: z
      .enum(CP_BULK_ACTIONS)
      .describe("Lifecycle action to run on each selected charge point"),
  })
  .strict();

export const cpBulkResultSchema = z.object({
  matched: ARRAY_1000(STR_64K),
  succeeded: ARRAY_1000(STR_64K),
  failed: ARRAY_1000(z.object({ cpId: STR_64K, reason: STR_64K })),
});
export type CpBulkResult = z.infer<typeof cpBulkResultSchema>;

/**
 * `cp.scenario.run` (#486): start one scenario template on every charge point
 * carrying every pair of `labels`. A method of its own (decision D07), not a
 * `cp.bulk` action: a scenario takes a connector, a template and options, and
 * folding them into `cp.bulk` would make its params a union, which the MCP
 * schema derivation avoids. The selector rule is `cp.bulk`'s.
 */
export const cpScenarioRunParamsSchema = z
  .object({
    labels: cpBulkParamsSchema.shape.labels,
    connector: CONN_POS.describe(
      "Connector the template runs on, on every selected charge point",
    ),
    templateId: NON_EMPTY_STR.describe("Scenario template identifier"),
    evSettings: OBJ()
      .optional()
      .describe("Overrides for the template's EV settings"),
    strict: z
      .boolean()
      .optional()
      .describe("Promote warning-severity assertions to failures"),
    once: z
      .boolean()
      .optional()
      .describe(
        "Run once: the instance is loaded disabled, so it does not re-arm on the next reconnect",
      ),
  })
  .strict();

export const cpScenarioRunResultSchema = z.object({
  matched: ARRAY_1000(STR_64K),
  /** One entry per charge point that started the run, with its scenario id. */
  started: ARRAY_1000(z.object({ cpId: STR_64K, scenarioId: STR_64K })),
  failed: ARRAY_1000(z.object({ cpId: STR_64K, reason: STR_64K })),
});
export type CpScenarioRunResult = z.infer<typeof cpScenarioRunResultSchema>;

/** update CP — redacted snapshots may omit password; server preserves it. */
export const updateParamsSchema = cpParamsBaseSchema.extend({
  basicAuth: z
    .object({ username: STR_64K, password: STR_64K.optional() })
    .nullable()
    .optional(),
});
