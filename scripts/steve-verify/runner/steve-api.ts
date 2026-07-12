/**
 * steve-api.ts -- REST driver for SteVe 3.13.0's typed `/api/v1/operations/*`
 * endpoints (issue #184 Finding 1: all 17 CSMS operations the manager UI's
 * `/manager/operations/*` forms expose are also available as typed-JSON
 * REST endpoints). This is the DEFAULT `SteveOps` driver (`STEVE_DRIVER=api`
 * or unset, selected in main.ts) -- see steve.ts's `SteveUiOps` for the
 * `STEVE_DRIVER=ui` fallback (manager-UI form POSTs).
 *
 * Issue #184 Task 3 grew this file a second driver, `SteveApiDb`
 * (implements steve.ts's `SteveTx`) -- REST for transactions/OCPP tags,
 * replacing direct MariaDB access everywhere the REST API covers it. See
 * the "Transactions + OCPP tags" section further down for its own header
 * (auth is identical to `SteveApiOps`'s below; the shapes differ).
 *
 * Every shape below was verified live against a running SteVe 3.13.0 (see
 * the #184 Task 2/3 reports for the full per-operation/endpoint
 * request/response captures) -- nothing here is inferred from source alone.
 *
 * ## Auth
 * `/api/**` is a SEPARATE Spring Security filter chain from the manager
 * UI's form-login/session/CSRF flow (SteVe's SecurityConfiguration#
 * apiKeyFilterChain: stateless, CSRF disabled, a bare BasicAuthenticationFilter
 * backed by ApiAuthenticationManager). It IS plain HTTP Basic auth, but
 * NOT against the manager-UI login password: `web_user.api_password` is a
 * separate bcrypt column, NULL by default. It's only auto-seeded (from the
 * `webapi.value` / `steve.auth.web-api-secret` config property) the FIRST
 * time an ADMIN user is ever created (WebUserService#afterStart is a
 * no-op once any ADMIN exists) -- so a pre-existing instance provisioned
 * before that property was set stays API-disabled forever without a
 * manual DB fix. A disabled/absent API password produces, regardless of
 * which password is sent:
 *   401 {"error":"Unauthorized","message":"The user does not exist, exists
 *        but is disabled or has API access disabled."}
 * This repo's local SteVe instance was exactly that case (fixed live via
 * `UPDATE web_user SET api_password = password WHERE username='admin'`,
 * reusing the existing bcrypt hash of the manager password so API creds
 * end up identical to STEVE_USER/STEVE_PASS -- see 01-setup-steve.sh,
 * which now seeds `webapi.value` for fresh SteVe checkouts so this isn't
 * a recurring fixup). WebUserService caches API user lookups for 10
 * minutes (Guava cache keyed by username) -- a DB-level fix to an
 * already-running instance needs an app container restart to take effect.
 *
 * ## Request shape
 * One operation per `POST /api/v1/operations/<Op>`, typed JSON. Every body
 * carries `chargeBoxIdList: string[]` (the REST equivalent of the manager
 * UI's `chargePointSelectList` -- see SteveOps#cpSelect's doc comment in
 * steve.ts for why this driver's cpSelect() just returns the bare cpId).
 * `buildOperationBody()` below maps each spec's UI-form-shaped `fields`
 * (see specs/*.ts call sites) onto the REST DTO's JSON field names/types;
 * every branch was confirmed against a live 2xx response.
 *
 * ## Response shape -- SYNCHRONOUS, not fire-and-forget
 * Unlike the manager UI (a 302 to a task page you poll separately), the
 * REST endpoint blocks server-side until every selected station responds
 * or SteVe's own 30s station-response timeout elapses
 * (OcppOperationsService#execute -> RestCallback#waitForResponses), then
 * returns the real result inline:
 *   { taskId, taskFinished, successResponses: [{chargeBoxId, response}],
 *     errorResponses: [{chargeBoxId, errorCode, errorDescription, errorDetails}],
 *     exceptions: [{chargeBoxId, exceptionMessage}] }
 * `taskFinished` is true once every selected station has answered (with a
 * CallResult OR a CallError) inside that 30s window; false means the
 * platform's timeout elapsed with no answer from at least one station
 * (tracked upstream as SteVe #2070). Live-verified BOTH ways against this
 * repo's simulator:
 *   - ClearCache/Reset(Soft)/UnlockConnector/GetConfiguration/
 *     ChangeConfiguration/GetLocalListVersion/SendLocalList/ReserveNow/
 *     CancelReservation/GetDiagnostics/UpdateFirmware/RemoteStartTransaction/
 *     RemoteStopTransaction/TriggerMessage/SetChargingProfile/
 *     GetCompositeSchedule/ClearChargingProfile all returned
 *     taskFinished=true with a populated successResponses[] in well under
 *     a second (the sim answers immediately).
 *   - Reset(Hard) returned taskFinished=false with EMPTY successResponses
 *     after a full ~30s block: the simulator's Hard Reset handling
 *     (matching real OCPP 1.6J behavior, already documented in
 *     specs/core.ts's tc013 spec) sends NO Reset.conf CallResult at all --
 *     it goes straight from "Reset request received: Hard" to
 *     StopTransaction to a WebSocket close-and-reboot. SteVe's
 *     RestCallback never counts down for that station, so it always
 *     blocks the full 30s and reports taskFinished=false. This is the
 *     live, first-hand reproduction of Finding 3/#2070, not a guess.
 *
 * Every spec's assert() checks the SIM's own captured wire log
 * (frames/lines), never this REST response -- op() below therefore does
 * NOT poll on taskFinished=false (there is nothing to poll for: the sim
 * has usually already finished its whole reaction, including a reconnect,
 * long before SteVe's 30s wait even elapses). It logs a WARN and returns
 * normally, exactly mirroring SteveUiOps#op()'s fire-and-continue
 * contract, at the cost of that op() call taking up to ~30s wall-clock
 * for operations the target CP answers silently to (Hard Reset today;
 * document any other such op here if one is found). Every affected
 * spec's holdSecs already budgets comfortably past that.
 */

import { SteveDb, waitForCondition } from "./steve";
import type { SteveConfig, SteveOps, SteveTx } from "./steve";

/** SteVe's own station-response budget is 30s
 *  (OcppOperationsService.STATION_RESPONSE_TIMEOUT) -- this must exceed
 *  it, or the client would abort (and throw) an in-flight request SteVe
 *  was always going to finish (successfully or with taskFinished=false)
 *  on its own. +10s margin for network/GC jitter on top of SteVe's 30s. */
const DEFAULT_TIMEOUT_MS = 40_000;

const OPERATIONS_PATH = "/operations/";

export interface SteveApiConfig {
  /** e.g. http://localhost:18180/steve/api/v1 (no trailing slash). */
  baseUrl: string;
  username: string;
  password: string;
}

export function defaultSteveApiConfig(
  env: NodeJS.ProcessEnv = process.env,
): SteveApiConfig {
  const appPort = env.STEVE_APP_HOST_PORT ?? "18180";
  return {
    baseUrl: env.STEVE_API_URL ?? `http://localhost:${appPort}/steve/api/v1`,
    // Falls back to the manager-UI creds (STEVE_USER/STEVE_PASS) since, in
    // this repo's provisioning, the API password IS the manager password
    // (see the file header) -- but a distinct STEVE_API_USER/PASS lets a
    // deployment with a real separate API credential override that.
    username: env.STEVE_API_USER ?? env.STEVE_USER ?? "admin",
    password: env.STEVE_API_PASS ?? env.STEVE_PASS ?? "1234",
  };
}

/** OcppOperationResponse<T> equivalent -- see SteVe's
 *  de.rwth.idsg.steve.web.dto.OcppOperationResponse. `response`/error
 *  fields are left loosely typed (unknown/string) -- this driver only
 *  ever logs them as evidence, never branches on their contents (see the
 *  file header: assert() checks the sim's wire log, not this). */
interface OcppOperationResponse {
  taskId: number;
  taskFinished: boolean;
  successResponses: Array<{ chargeBoxId: string; response: unknown }>;
  errorResponses: Array<{
    chargeBoxId: string;
    errorCode: string;
    errorDescription: string;
    errorDetails: string;
  }>;
  exceptions: Array<{ chargeBoxId: string; exceptionMessage: string }>;
}

function toInt(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) {
    throw new Error(`steve-api: expected an integer, got "${value}"`);
  }
  return n;
}

/** UI form fields that map to a REST `string[]` (SendLocalList's
 *  addUpdateList/deleteList, GetConfiguration's confKeyList) are
 *  comma-separated in every current spec call site (always a single tag/
 *  key today, but written generically). */
function toList(value: string | undefined): string[] | undefined {
  if (value === undefined || value === "") return undefined;
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/** Manager-UI form codes (HARD/SOFT for resetType, FULL/DIFFERENTIAL for
 *  updateType) -> the wire-cased enum values the REST DTOs expect
 *  (Hard/Soft, Full/Differential -- live-verified). Title-cased
 *  generically rather than a lookup table since both pairs happen to
 *  follow the same convention. */
function titleCase(value: string): string {
  if (value === "") return value;
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

/** reservationExpirySoon()/retrieveDatetimeSoon() (steve.ts) return
 *  "YYYY-MM-DD HH:MM" -- no seconds, always UTC (that's the manager UI
 *  form's input format). The REST DTOs' org.joda.time.DateTime fields
 *  parse ISO-8601; "YYYY-MM-DDTHH:MM:00.000Z" was live-verified for both
 *  ReserveNow's `expiry` and UpdateFirmware's `retrieveDateTime`. */
function toIsoDateTime(value: string): string {
  return `${value.replace(" ", "T")}:00.000Z`;
}

/**
 * Maps steve.op()'s UI-form-shaped `fields` (identical field NAMES to the
 * manager UI's <form> inputs -- see specs/*.ts call sites, all
 * string-valued) onto the JSON body `POST /api/v1/operations/<opName>`
 * expects. Pure and exported for unit testing; every branch was confirmed
 * against a live 2xx SteVe 3.13.0 response (see the #184 Task 2 report).
 *
 * `opName` is the bare operation name (e.g. "Reset"), NOT the
 * "v1.6/Reset" opPath specs pass to steve.op() -- SteveApiOps#op() strips
 * the "v1.6/" prefix before calling this (the REST API has no per-OCPP-
 * version path segment; SteVe resolves the protocol version per station).
 */
export function buildOperationBody(
  opName: string,
  fields: Record<string, string>,
): Record<string, unknown> {
  const cpId = fields.chargePointSelectList;
  if (!cpId) {
    throw new Error(
      `steve-api: op ${opName} is missing fields.chargePointSelectList (cpId) -- ` +
        "every spec call site is expected to pass steve.cpSelect(cpId) for this field",
    );
  }
  const base = { chargeBoxIdList: [cpId] };

  switch (opName) {
    case "ClearCache":
    case "GetLocalListVersion":
      return base;

    case "Reset":
      return { ...base, resetType: titleCase(fields.resetType ?? "") };

    case "UnlockConnector":
      return { ...base, connectorId: toInt(fields.connectorId) };

    case "GetConfiguration":
      // Absent/empty confKeyList means "all keys" -- live-verified.
      return { ...base, confKeyList: toList(fields.confKeyList) };

    case "ChangeConfiguration":
      return {
        ...base,
        keyType: fields.keyType,
        confKey: emptyToUndefined(fields.confKey),
        customConfKey: fields.customConfKey ?? "",
        value: fields.value ?? "",
      };

    case "SendLocalList":
      return {
        ...base,
        listVersion: toInt(fields.listVersion),
        updateType: titleCase(fields.updateType ?? ""),
        addUpdateList: toList(fields.addUpdateList),
        deleteList: toList(fields.deleteList),
      };

    case "ReserveNow":
      return {
        ...base,
        connectorId: toInt(fields.connectorId),
        expiry: toIsoDateTime(fields.expiry),
        idTag: fields.idTag,
      };

    case "CancelReservation":
      return { ...base, reservationId: toInt(fields.reservationId) };

    case "RemoteStartTransaction":
      return {
        ...base,
        connectorId: toInt(fields.connectorId),
        idTag: fields.idTag,
        // "" (no profile selected) -> omitted, matching the DTO's
        // optional @Positive Integer (0 would fail validation).
        chargingProfilePk: toInt(fields.chargingProfilePk),
      };

    case "RemoteStopTransaction":
      return { ...base, transactionId: toInt(fields.transactionId) };

    case "TriggerMessage":
      return {
        ...base,
        triggerMessage: fields.triggerMessage,
        connectorId: toInt(fields.connectorId),
      };

    case "GetDiagnostics":
      return { ...base, location: fields.location };

    case "UpdateFirmware":
      return {
        ...base,
        location: fields.location,
        retrieveDateTime: toIsoDateTime(fields.retrieveDateTime),
      };

    case "SetChargingProfile":
      return {
        ...base,
        connectorId: toInt(fields.connectorId),
        chargingProfilePk: toInt(fields.chargingProfilePk),
        transactionId: toInt(fields.transactionId),
      };

    case "GetCompositeSchedule":
      return {
        ...base,
        connectorId: toInt(fields.connectorId),
        durationInSeconds: toInt(fields.durationInSeconds),
        chargingRateUnit: emptyToUndefined(fields.chargingRateUnit),
      };

    case "ClearChargingProfile":
      return { ...base, chargingProfilePk: toInt(fields.chargingProfilePk) };

    default:
      throw new Error(
        `steve-api: no REST field mapping for operation "${opName}" -- ` +
          "add one to buildOperationBody() (steve-api.ts), or run this " +
          "scenario with STEVE_DRIVER=ui until it's added",
      );
  }
}

/** REST driver: SteveOps over SteVe's `/api/v1/operations/*` (Basic auth,
 *  typed JSON, stateless). Default (`STEVE_DRIVER=api` or unset) -- see
 *  the file header for the auth/response shapes this was verified
 *  against, and steve.ts's SteveUiOps for the `STEVE_DRIVER=ui`
 *  fallback. */
export class SteveApiOps implements SteveOps {
  constructor(private readonly cfg: SteveApiConfig) {}

  /** The REST DTOs take `chargeBoxIdList: string[]` directly -- no
   *  manager-UI select-list encoding needed. op()'s field mapper
   *  (buildOperationBody) reads this straight back out as the (sole)
   *  entry in chargeBoxIdList. */
  cpSelect(cpId: string): string {
    return cpId;
  }

  async op(opPath: string, fields: Record<string, string>): Promise<string> {
    const opName = opPath.includes("/")
      ? opPath.slice(opPath.lastIndexOf("/") + 1)
      : opPath;
    const body = buildOperationBody(opName, fields);
    const url = `${this.cfg.baseUrl}${OPERATIONS_PATH}${opName}`;
    const cpId = fields.chargePointSelectList ?? "?";

    // Evidence-logging helper: request method/url/body + response, with
    // credentials REDACTED -- the Authorization header (and the
    // username/password that built it) are deliberately never passed to
    // this or logged anywhere (#184's explicit ask).
    const logEvidence = (outcome: string): void => {
      process.stderr.write(
        `[runner] steve-api POST ${OPERATIONS_PATH}${opName} cp=${cpId} ` +
          `body=${JSON.stringify(body)} -> ${outcome}\n`,
      );
    };

    const authHeader = `Basic ${Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString("base64")}`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: authHeader,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    const responseText = await res.text();

    if (!res.ok) {
      logEvidence(`HTTP ${res.status}: ${responseText.slice(0, 500)}`);
      throw new Error(
        `steve-api: POST ${OPERATIONS_PATH}${opName} failed (HTTP ${res.status}): ` +
          responseText.slice(0, 300),
      );
    }

    let parsed: OcppOperationResponse | undefined;
    try {
      parsed = JSON.parse(responseText) as OcppOperationResponse;
    } catch {
      // A non-JSON 2xx would be unexpected, but shouldn't crash the
      // caller -- the sim's own wire log is the real check (see the file
      // header), this driver's job is just "did the CSMS accept and
      // dispatch the operation".
    }

    logEvidence(JSON.stringify(parsed ?? responseText.slice(0, 300)));

    if (parsed && !parsed.taskFinished) {
      // Finding 3 / SteVe #2070 -- see the file header's Reset(Hard)
      // reproduction. Not polled: nothing to poll for (assert() checks
      // the sim's own wire capture, not this response).
      process.stderr.write(
        `[runner] WARN: steve-api ${opName} taskFinished=false (taskId=${parsed.taskId}) -- ` +
          "platform timeout before every selected station answered; continuing " +
          "(assert() checks the sim's own wire log, not this response)\n",
      );
    }

    return parsed
      ? `taskId=${parsed.taskId} taskFinished=${parsed.taskFinished}`
      : responseText;
  }
}

// =============================================================================
// Transactions + OCPP tags (issue #184 Task 3): SteVe 3.13.0's
// `/api/v1/transactions` and `/api/v1/ocppTags` REST controllers, replacing
// direct MariaDB access for everything they cover. Every shape below was
// captured live against a running SteVe 3.13.0 -- see the #184 Task 3
// report for the full raw captures (curl output + the Spring source read
// straight out of the running container, same method Task 2 used for the
// operations API).
//
// ## Transactions -- `GET /api/v1/transactions`
// `TransactionsRestController#get` takes `TransactionQueryForm
// .TransactionQueryFormForApi` query params -- notably `chargeBoxId` /
// `ocppIdTag` (repeatable list params, `QueryForm`), and `type`
// (`TransactionQueryForm.QueryType`: `ALL`/`ACTIVE`/`STOPPED`,
// **UPPERCASE, case-sensitive** -- `?type=Active` 400s, `?type=ACTIVE`
// 200s, live-verified). Unlike the manager UI's `TransactionQueryForm`
// (whose bare constructor defaults `type` to `ACTIVE`),
// `TransactionQueryFormForApi`'s constructor overrides both `type` and
// `periodType` to `ALL` -- so the REST list defaults to every transaction,
// open or closed, no `type` param needed for a `latestTxPk`-style lookup.
// Results are `.orderBy(TRANSACTION.TRANSACTION_PK.desc())`
// (`TransactionRepositoryImpl#getTransactions`, source-verified, not an
// artifact of this dataset) -- the first element of a `chargeBoxId`-
// filtered list IS `db_latest_tx_pk`'s answer.
//
// ## Transaction detail -- `GET /api/v1/transactions/{transactionPk}`
// Returns `TransactionDetails { transaction, values }` -- `values` is the
// full `MeterValues[]` list for that transaction (live-verified:
// `energyValuesOnly=true`, the default, returns only
// `Energy.Active.Import.Register` samples; `energyValuesOnly=false`
// additionally includes `Power.Active.Import`). **MeterValues ARE exposed
// via REST** -- no DB fallback needed for them (none of the 47 specs
// currently assert on MeterValues content, but the capability is here).
// A nonexistent `transactionPk` 404s with a clean JSON error body
// (live-verified) -- `getTransactionDetailsOrUndefined` below treats that
// as "no such transaction", matching `scalar()`'s "" for a zero-row SQL
// SELECT.
//
// ## Stale-transaction close -- `PATCH /api/v1/transactions/{pk}/stop`
// No request body. Live-verified: closes an open transaction with
// `stopEventActor:"manual"`, `stopValue:"0"` -- the exact same shape
// `SteveDb#closeStaleTx`'s raw `INSERT INTO transaction_stop (...,
// event_actor, ..., stop_value, ...) VALUES (..., 'manual', ..., '0',
// ...)` produces. Also live-verified **idempotent**: PATCHing an
// already-closed transaction still 200s (no-op), so `closeStaleTx` below
// doesn't need to special-case "already closed" itself.
//
// ## OCPP tags -- `GET/POST/PUT/DELETE /api/v1/ocppTags`
// `OcppTagForm` (`POST`/`PUT` body): `idTag` (required), `parentIdTag`,
// `expiryDate` (ISO-8601, **`@Future`-validated on BOTH create AND
// update** -- live-verified: a past date -> `400 Bad Request` on POST,
// confirmed the same DTO/validation applies to PUT by inspecting the
// controller: both `create()` and `update()` take `@Valid OcppTagForm`),
// `maxActiveTransactionCount`, `note`. Response (`OcppTagOverview`)
// additionally carries `blocked`/`inTransaction`/`activeTransactionCount`
// -- all **derived**, not stored columns (confirmed via `DESCRIBE
// ocpp_tag`: no `blocked` column exists; `blocked` is
// `max_active_transaction_count == 0`, live-verified by POSTing
// `maxActiveTransactionCount:0` and reading back `"blocked":true`).
// `idTag` lookup-by-value: `GET /ocppTags?idTag=<exact>` (live-verified
// exact match, used to resolve a `POST`-returned `ocppTagPk` for a later
// `PUT`/`DELETE`).
//
// **The CERT023-EXP gap (TC_023.2, issue #181): cannot be provisioned via
// REST.** An EXPIRED tag needs `expiry_date` in the past, but
// `OcppTagForm.expiryDate`'s `@Future` validation rejects that
// unconditionally on both create and update (400, live-verified) -- there
// is no request shape that gets a past `expiryDate` into SteVe through
// this endpoint. `02-provision.sh` keeps the direct `UPDATE ocpp_tag SET
// expiry_date = ...` SQL for this ONE field as a documented, permanent DB
// fallback (not a gap expected to close -- `@Future` is presumably
// intentional server-side validation, not a missing feature). Every other
// tag-provisioning step (CERT023-BLK's `maxActiveTransactionCount=0`,
// CERT023-INV's non-existence, and the whole CERT-TAG-1..8 +
// scenario-discovered pool) is fully REST-driven -- see 02-provision.sh
// and lib.sh's `steve_api_*` helpers.
// =============================================================================

/** `de.rwth.idsg.steve.repository.dto.Transaction` (REST JSON). "For
 *  active transactions, all 'stop'-prefixed fields would be null." (the
 *  DTO's own Swagger description, live-verified). */
export interface ApiTransaction {
  id: number;
  connectorId: number;
  chargeBoxPk: number;
  ocppTagPk: number;
  chargeBoxId: string;
  ocppIdTag: string;
  userId: number | null;
  startValue: string;
  startTimestamp: string;
  stopValue: string | null;
  stopReason: string | null;
  stopTimestamp: string | null;
  stopEventActor: string | null;
}

/** `TransactionDetails.MeterValues` (REST JSON, nested under `values[]`). */
export interface ApiMeterValue {
  valueTimestamp: string;
  value: string;
  readingContext: string | null;
  format: string | null;
  measurand: string | null;
  location: string | null;
  unit: string | null;
  phase: string | null;
}

/** `GET /api/v1/transactions/{transactionPk}` response shape. */
export interface ApiTransactionDetails {
  transaction: ApiTransaction;
  values: ApiMeterValue[];
}

/** `OcppTagOverview` (REST JSON) -- `GET /api/v1/ocppTags` list/detail
 *  response shape, and what a successful `POST`/`PUT`/`DELETE` echoes
 *  back. */
export interface ApiOcppTag {
  ocppTagPk: number;
  idTag: string;
  parentIdTag: string | null;
  parentOcppTagPk: number | null;
  expiryDate: string | null;
  maxActiveTransactionCount: number;
  note: string | null;
  userPk: number | null;
  /** Derived (`maxActiveTransactionCount === 0`), not a stored column --
   *  see this section's header comment. */
  blocked: boolean;
  inTransaction: boolean;
  activeTransactionCount: number;
}

/** REST equivalent of steve.ts's `SteveConfig` for the transactions/tags
 *  client -- deliberately the same shape as `SteveApiConfig` (this file
 *  already has one), but a distinct type so a caller can't accidentally
 *  pass an operations config where a transactions/tags config is
 *  expected (both happen to be structurally identical today; kept
 *  separate for that reason, not because the fields differ). */
export type SteveApiDbConfig = SteveApiConfig;

/** `env` -> `SteveApiDbConfig` -- same defaults/env vars as
 *  {@link defaultSteveApiConfig} (one SteVe REST API, one set of
 *  credentials). */
export const defaultSteveApiDbConfig = defaultSteveApiConfig;

/** `db.latestTxPk()`'s answer from an already newest-first `/transactions`
 *  response (see this section's header: SteVe itself orders by
 *  `transaction_pk DESC`) -- the first element's id, or "" if the list is
 *  empty. Pure, exported for unit testing. */
export function pickLatestTxPk(
  transactions: readonly { id: number }[],
): string {
  return transactions.length > 0 ? String(transactions[0].id) : "";
}

/** REST's JSON `null` -> steve.ts's "" not-set sentinel (assert.ts's
 *  `assertNonEmpty` checks `value !== ""`). Pure, exported for unit
 *  testing. */
export function nullableToEmpty(value: string | null | undefined): string {
  return value === null || value === undefined ? "" : value;
}

/** Builds the `/transactions` query string. `chargeBoxId`/`ocppIdTag` are
 *  SteVe's repeatable list params (only ever a single value from this
 *  driver's callers); `type` must be UPPERCASE (see this section's header
 *  -- `?type=Active` 400s). Pure, exported for unit testing. */
export function buildTransactionsQuery(params: {
  chargeBoxId?: string;
  ocppIdTag?: string;
  type?: "ALL" | "ACTIVE" | "STOPPED";
}): string {
  const qs = new URLSearchParams();
  if (params.chargeBoxId) qs.set("chargeBoxId", params.chargeBoxId);
  if (params.ocppIdTag) qs.set("ocppIdTag", params.ocppIdTag);
  if (params.type) qs.set("type", params.type);
  return qs.toString();
}

/** GET/PATCH timeout for the transactions/tags client -- ordinary
 *  request/response calls (not `SteveApiOps#op()`'s synchronous-CSMS-op
 *  30s+ budget), so the same 10s every other non-op HTTP call in this
 *  suite uses (steve.ts's `DEFAULT_TIMEOUT_MS`). */
const DB_DEFAULT_TIMEOUT_MS = 10_000;

/**
 * REST driver for `SteveTx` (steve.ts): SteVe 3.13.0's
 * `/api/v1/transactions` for everything transaction-shaped, with a
 * DB-backed fallback ONLY for `latestReservationPk`/`reservationStatus`
 * (no REST reservations endpoint exists -- see steve.ts's `SteveTx` doc
 * comment). Default (`STEVE_DRIVER=api` or unset) -- see steve.ts's
 * `SteveDb` for the `STEVE_DRIVER=ui`/`db` fallback, and this file's
 * section header above for the request/response shapes this was verified
 * against.
 */
export class SteveApiDb implements SteveTx {
  private readonly dbFallback: SteveDb;

  constructor(
    private readonly cfg: SteveApiDbConfig,
    dbFallbackCfg: SteveConfig,
  ) {
    this.dbFallback = new SteveDb(dbFallbackCfg);
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString("base64")}`;
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      headers: {
        accept: "application/json",
        authorization: this.authHeader(),
      },
      signal: AbortSignal.timeout(DB_DEFAULT_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `steve-api-db: GET ${path} failed (HTTP ${res.status}): ${text.slice(0, 300)}`,
      );
    }
    return JSON.parse(text) as T;
  }

  private async listTransactions(params: {
    chargeBoxId?: string;
    ocppIdTag?: string;
    type?: "ALL" | "ACTIVE" | "STOPPED";
  }): Promise<ApiTransaction[]> {
    return this.getJson<ApiTransaction[]>(
      `/transactions?${buildTransactionsQuery(params)}`,
    );
  }

  /** Returns `undefined` for a nonexistent `transactionPk` (REST 404s --
   *  live-verified, see this section's header) instead of throwing --
   *  every caller below treats "no such transaction" the same as
   *  scalar()'s "" for a zero-row SELECT. Also short-circuits on an empty
   *  `txPk` (every real spec call site already guards `if (!txPk)` before
   *  calling in, but SteVe would 400 on `/transactions/` with no id). */
  private async getTransactionDetails(
    txPk: string,
  ): Promise<ApiTransactionDetails | undefined> {
    if (!txPk) return undefined;
    const res = await fetch(`${this.cfg.baseUrl}/transactions/${txPk}`, {
      headers: {
        accept: "application/json",
        authorization: this.authHeader(),
      },
      signal: AbortSignal.timeout(DB_DEFAULT_TIMEOUT_MS),
    });
    if (res.status === 404) return undefined;
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `steve-api-db: GET /transactions/${txPk} failed (HTTP ${res.status}): ${text.slice(0, 300)}`,
      );
    }
    return JSON.parse(text) as ApiTransactionDetails;
  }

  async latestTxPk(cpId: string): Promise<string> {
    const txs = await this.listTransactions({ chargeBoxId: cpId });
    return pickLatestTxPk(txs);
  }

  async waitActiveTxPk(
    cpId: string,
    idTag: string,
    timeoutSecs = 15,
  ): Promise<string> {
    return waitForCondition(
      async () => {
        const txs = await this.listTransactions({
          chargeBoxId: cpId,
          ocppIdTag: idTag,
          type: "ACTIVE",
        });
        return pickLatestTxPk(txs) || undefined;
      },
      {
        timeoutMs: timeoutSecs * 1000,
        intervalMs: 1_000,
        description: `active transaction on ${cpId} (id_tag=${idTag})`,
      },
    );
  }

  async closeStaleTx(cpId: string): Promise<void> {
    const txs = await this.listTransactions({
      chargeBoxId: cpId,
      type: "ACTIVE",
    });
    const pk = pickLatestTxPk(txs);
    if (!pk) return;
    const res = await fetch(`${this.cfg.baseUrl}/transactions/${pk}/stop`, {
      method: "PATCH",
      headers: { authorization: this.authHeader() },
      signal: AbortSignal.timeout(DB_DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "<unreadable body>");
      throw new Error(
        `steve-api-db: PATCH /transactions/${pk}/stop failed (HTTP ${res.status}): ${text.slice(0, 300)}`,
      );
    }
  }

  /** DB-only fallback -- see this class's doc comment and steve.ts's
   *  `SteveTx`. */
  async latestReservationPk(cpId: string): Promise<string> {
    return this.dbFallback.latestReservationPk(cpId);
  }

  /** DB-only fallback -- see {@link latestReservationPk}. */
  async reservationStatus(reservationPk: string): Promise<string> {
    return this.dbFallback.reservationStatus(reservationPk);
  }

  async txIdTag(txPk: string): Promise<string> {
    const details = await this.getTransactionDetails(txPk);
    return details?.transaction.ocppIdTag ?? "";
  }

  async txStopTimestamp(txPk: string): Promise<string> {
    const details = await this.getTransactionDetails(txPk);
    return nullableToEmpty(details?.transaction.stopTimestamp);
  }

  async txStopReason(txPk: string): Promise<string> {
    const details = await this.getTransactionDetails(txPk);
    return nullableToEmpty(details?.transaction.stopReason);
  }

  async txCountForTag(cpId: string, idTag: string): Promise<string> {
    const txs = await this.listTransactions({
      chargeBoxId: cpId,
      ocppIdTag: idTag,
    });
    return String(txs.length);
  }
}
