import { z } from "zod";
import {
  ARRAY_1000,
  STR_256,
  OBJ_MAX_BYTES,
  SCENARIO_MAX_BYTES,
  STR_64K,
  boundedObject,
} from "../limits";
import { STOP_REASONS } from "../transactionVocabulary";
import {
  CHARGING_SESSION_OUTCOMES,
  MAX_SESSIONS_PER_CP,
} from "../chargingSession";
import {
  AUTHORIZATION_CACHE_SEED_MAX,
  AUTHORIZATION_STATUSES,
} from "../authorization";
import { idTokenKey } from "../idTokenKey";
import { type ScenarioMode } from "../scenario";
import { TIMELINE_KINDS } from "../timeline";

export const CONN_POS = z.number().int().min(1);
export const CONN_NONNEG = z.number().int().min(0);
export const CONN_DEF = CONN_POS.nullable();
export const EMPTY = z.object({});
/**
 * The opt-in stop of `cp.delete` / `disconnect`: the running transactions are
 * stopped, and the answers waited for up to the daemon's `--shutdown-wait-ms`,
 * before the charge point is closed. Without it the charge point goes away
 * with its transactions open and sends nothing.
 */
export const STOP_ON_CLOSE = {
  stopTransactions: z
    .boolean()
    .optional()
    .describe(
      "Stop every running transaction first (1.6 StopTransaction, 2.x TransactionEvent Ended with triggerReason AbnormalCondition) and wait up to the daemon's --shutdown-wait-ms (default 5000) for the CSMS to answer. Default false: the transactions stay open and nothing is sent",
    ),
  reason: z
    .enum(STOP_REASONS)
    .optional()
    .describe(
      "With stopTransactions: StopTransaction.req reason (1.6) / stoppedReason (2.x); default Other, as the shutdown stop",
    ),
};
/**
 * A string that names something — an id, a tag, a vendor, a path. Empty names
 * nothing, and the handlers do not re-check (#383): an empty `tagId` would
 * skip the idTag pool, an empty `scenarioId` would look up no scenario.
 */
export const NON_EMPTY_STR = STR_64K.min(1);
/** The connector modes `set_mode` accepts. */
export const SCENARIO_MODES = [
  "manual",
  "scenario",
] as const satisfies readonly ScenarioMode[];
export const ANY = z.unknown();

/** #388: `scenario.runs.list` page size — the default, and the most a page
 *  may ask for. */
export const SCENARIO_RUNS_PAGE_DEFAULT = 50;
export const SCENARIO_RUNS_PAGE_MAX = 200;
/** #447: `sessions.list` page size — the default, and the most a page may
 *  ask for (a charge point's whole retained history). */
export const CHARGING_SESSIONS_PAGE_DEFAULT = 50;
export const CHARGING_SESSIONS_PAGE_MAX = MAX_SESSIONS_PER_CP;
/** #489: an ISO 8601 instant with a zone designator, e.g. 2026-11-08T00:00:00Z. */
export const ISO_INSTANT = z
  .string()
  .datetime({ offset: true })
  .describe("ISO 8601 instant with a zone, e.g. 2026-11-08T00:00:00Z");
/** #447: one charging session, the same shape for every OCPP version. */
export const chargingSessionSchema = z.object({
  sessionId: z.string(),
  cpId: z.string(),
  connectorId: z.number().int(),
  evseId: z.number().int().nullable(),
  ocppVersion: z.string(),
  transactionId: z.string().nullable(),
  idTag: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  meterStartWh: z.number(),
  meterStopWh: z.number().nullable(),
  energyWh: z.number().nullable(),
  stopReason: z.string().nullable(),
  triggerReason: z.string().nullable(),
  authorizationStatus: z.string().nullable(),
  outcome: z.enum(CHARGING_SESSION_OUTCOMES),
});
/** #612: what `cp.config_keys.set` answers when the write took. */
export const CONFIG_KEY_SET_STATUSES = ["Accepted", "RebootRequired"] as const;
/** #612: one configuration key of a running charge point. */
export const configKeyInfoSchema = z.object({
  key: STR_256,
  /** Empty for a write-only key (AuthorizationKey is never returned). */
  value: STR_64K,
  type: z.enum(["string", "integer", "boolean", "array"]),
  readonly: z.boolean(),
  /** 2.x only: the Device Model name and mutability behind the key. */
  component: STR_256.optional(),
  variable: STR_256.optional(),
  instance: STR_256.optional(),
  mutability: z.enum(["ReadOnly", "ReadWrite", "WriteOnly"]).optional(),
});
/** #448: one operational-timeline entry. `data` is kind-specific. */
export const timelineEntrySchema = z.object({
  seq: z.number().int().positive(),
  timestamp: z.string(),
  kind: z.enum(TIMELINE_KINDS),
  cpId: z.string(),
  connectorId: z.number().int().optional(),
  runId: z.string().optional(),
  incidentId: z.string().optional(),
  summary: z.string(),
  data: z.record(z.string(), z.unknown()),
});
/** A bounded free-form object param (settings/config/options): ≤ 64 KB. */
export const OBJ = () => boundedObject(OBJ_MAX_BYTES);
/** A bounded scenario-definition object param: ≤ 256 KB. */
export const SCENARIO_OBJ = () => boundedObject(SCENARIO_MAX_BYTES);
/**
 * `data_transfer`'s `data` (#348): a string or a bounded object. Exported so
 * JSON-Lines mode, which never sees this table, validates against the same
 * schema rather than a copy of its bounds (#382).
 */
export const dataTransferDataSchema = z.union([STR_64K, OBJ()]);
/** An identifier, at the widest any version carries it: 2.1
 *  IdTokenType.idToken is at most 255 characters (2.0.1: 36, 1.6 IdToken:
 *  20). The charge point refuses one longer than its own version allows
 *  (`idTokenMaxLength`, InvalidAuthorizationCacheSeedError →
 *  invalid_params). */
export const ID_TOKEN = NON_EMPTY_STR.max(255);
/**
 * `seed_auth_cache`'s entries (#452): an array, not a record keyed
 * by idToken, so an identifier never lands on a prototype key. Bounded by
 * the cache capacity; one entry per idToken, compared case-insensitively
 * like the cache does (`idTokenKey`). Exported so JSON-Lines mode
 * validates against the same schema (#382).
 */
export const authorizationCacheSeedSchema = z
  .array(
    z.object({
      idToken: ID_TOKEN,
      status: z.enum(AUTHORIZATION_STATUSES),
      // An ISO 8601 date-time with `Z` or an offset: Date.parse would also
      // take "2026" or "soon 1", depending on the engine.
      expiresAt: z.iso.datetime({ offset: true }).optional(),
      parentId: ID_TOKEN.optional(),
    }),
  )
  .min(1)
  .max(AUTHORIZATION_CACHE_SEED_MAX)
  .refine(
    (entries) =>
      new Set(entries.map((e) => idTokenKey(e.idToken))).size ===
      entries.length,
    { message: "each idToken may appear once" },
  );
export const authorizationCacheViewSchema = z.object({
  enabled: z.boolean(),
  entries: z.array(
    z.object({
      idToken: z.string(),
      status: z.string(),
      expiresAt: z.string().optional(),
      parentId: z.string().optional(),
      insertedAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
});
/** `send_ocpp_call`'s result (#389): the CSMS's CALLRESULT or CALLERROR,
 *  with the frame exactly as it was written. */
export const ocppCallOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("callResult"),
    messageId: z.string(),
    sentFrame: z.string(),
    payload: z.unknown(),
  }),
  z.object({
    kind: z.literal("callError"),
    messageId: z.string(),
    sentFrame: z.string(),
    errorCode: z.string(),
    errorDescription: z.string(),
    errorDetails: z.unknown(),
  }),
]);
/** `send_raw_frame`'s result (#393): best-effort correlation of what came
 *  back for one raw frame. */
export const rawFrameOutcomeSchema = z.object({
  sentFrame: z.string(),
  messageId: z.string().nullable(),
  reply: z.array(z.unknown()).nullable(),
  closed: z.string().nullable(),
});
/**
 * Base64 text (RFC 4648, padded, no whitespace): `get_15118_ev_certificate`'s
 * `exiRequest` (#537). One character class and a bounded tail, so the check
 * stays linear on a long input.
 */
export const BASE64_STR = NON_EMPTY_STR.regex(/^[A-Za-z0-9+/]*={0,2}$/, {
  message: "must be base64",
}).refine((value) => value.length % 4 === 0, {
  message: "base64 length must be a multiple of 4",
});
/** `get_15118_ev_certificate`'s result (#537): every CALLRESULT payload, as
 *  the CSMS sent it; a CALLERROR answering the last request; or `noAnswer`
 *  when a repeated request got none. */
export const get15118EVCertificateResultSchema = z.object({
  responses: z.array(z.unknown()),
  callError: z
    .object({
      errorCode: z.string(),
      errorDescription: z.string(),
      errorDetails: z.unknown(),
    })
    .optional(),
  noAnswer: z.enum(["timeout", "dropped"]).optional(),
});
/**
 * `extend_scenario_wait`'s `seconds` (#240): a whole number of seconds,
 * 1–3600. Exported for the same reason as `dataTransferDataSchema`.
 */
export const scenarioWaitExtensionSecondsSchema = z
  .number()
  .int()
  .min(1)
  .max(3600);
/**
 * A scenario definition that is actually loadable: bounded, plus the fields the
 * runtime keys on. `load_scenario` used to take a free-form bounded object, so a
 * payload with no `id` was accepted and stored under the key `undefined` —
 * reported back as `{}` instead of `{ scenarioId }`, and left in
 * `list_scenarios` as an entry that could be neither run nor removed.
 *
 * Failing here is what turns that into a proper `invalid_params` for both
 * Socket.IO and MCP (see `parseRpcParams` in socketServer.ts). An intersection
 * keeps the byte bound and stays permissive about unknown keys — real editor
 * exports carry xyflow UI fields. `CLIChargePointService.loadScenario`
 * re-checks `id`, `nodes` and `edges` for the paths that never see this schema
 * (`file`, the startup loaders) and fills in a missing `name` / `targetType`
 * there, as the web console's import does (`checkLoadableScenario`); this wire
 * schema still requires both. Full schema conformance remains advisory
 * (issue #214).
 */
export const LOADABLE_SCENARIO_OBJ = () =>
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
 * Which of the loaded behaviors a charge point runs (`--behavior` loads code
 * into a library at start; a charge point selects from it by id). Ids are data:
 * nothing here, and no other method, accepts behavior source or a path. An
 * unknown id is refused with the loaded ids named. Absent means every loaded
 * behavior (today's behavior); `[]` means none.
 */
export const behaviorIdsSchema = ARRAY_1000(STR_256.min(1)).describe(
  "Ids of the loaded behaviors (--behavior) this charge point runs; absent: every loaded behavior, []: none. Ids only, never code: an unknown id is an error naming the loaded ids. On cp.update an omitted list keeps the current selection",
);

/**
 * The params a charge point's selection sets on behaviors (#654): behavior id
 * to a JSON object of that behavior's params. Ids and JSON only, exactly like
 * {@link behaviorIdsSchema}: a param is a value the behavior's own schema
 * checks (refused, never coerced), never a module, a path, a URL or source
 * text. A key is a loaded behavior id or a built-in `default.*` id.
 */
export const BEHAVIOR_PARAMS_MAX_BYTES = 16_384;
export const behaviorParamsSchema = z
  .record(STR_256.min(1), boundedObject(BEHAVIOR_PARAMS_MAX_BYTES))
  .refine((all) => Object.keys(all).length <= 1000, {
    message: "at most 1000 behaviors",
  })
  .describe(
    'Params per behavior id, e.g. {"default.firmware": {"stepMs": 500, "failAt": "DownloadFailed"}}. JSON values only, checked against the params schema the behavior declares (see behavior.list); a value that does not fit is an error, nothing is converted. A key is a built-in default.* id or one of the selected behaviors. On cp.update an omitted map keeps the current params; a given one replaces them',
  );
