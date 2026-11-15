import * as path from "path";
import type { ChargePointInitOptions } from "../types";
import {
  isOcppVersion,
  isSoapVersion,
} from "@ocpp-cp-simulator/core/cp/domain/types/OcppVersion";
import { transportConfigSchema } from "@ocpp-cp-simulator/contracts/transportConfig";
import { labelsSchema } from "@ocpp-cp-simulator/contracts/labels";
import { modemConfigProblem } from "@ocpp-cp-simulator/core/cp/domain/modem/CellularModem";
import { chargerCapabilitiesProblem } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargerCapabilities";
import {
  DISABLED_ACTION_ERROR_CODES,
  STATUS_TRANSITION_MODES,
} from "@ocpp-cp-simulator/core/cp/domain/charge-point/CapabilityProfile";
import {
  behaviorIdsSchema,
  behaviorParamsSchema,
} from "@ocpp-cp-simulator/contracts/methods";
import { MAX_ID_TAGS, readIdTagsFile } from "./idTagFile";
import { normalizeSoapPath } from "../soapPath";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Whether a string parses as a `ws:` / `wss:` URL. */
function isWebSocketUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "ws:" || protocol === "wss:";
  } catch {
    return false;
  }
}

export interface ParseCreateBodyOptions {
  /**
   * The daemon has a SOAP public base (`--soap-public-base-url` or a
   * `--soap-tunnel`) and the registry derives a missing callback URL from it
   * at instantiation, so a SOAP body without one is complete (#183).
   */
  readonly soapCallbackUrlDerivable?: boolean;
}

export function parseCreateBody(
  body: unknown,
  opts: ParseCreateBodyOptions = {},
): ChargePointInitOptions {
  if (!isRecord(body)) throw new Error("body must be an object");
  const cpId = body.cpId;
  if (typeof cpId !== "string" || cpId.length === 0) {
    throw new Error("cpId is required (string)");
  }
  // `wsUrl` may be one URL or several. Several is an OCPP-J concept — the
  // check that it is not SOAP happens below, once the version is known — and
  // the list is kept beside a single `wsUrl` rather than replacing it, so the
  // status snapshot, the persisted `charge_points.ws_url` and every log line
  // keep seeing one string.
  const rawWsUrl = body.wsUrl;
  let supervisionUrls: string[] | undefined;
  if (Array.isArray(rawWsUrl)) {
    supervisionUrls = rawWsUrl.filter(
      (u): u is string => typeof u === "string" && u.length > 0,
    );
    if (supervisionUrls.length !== rawWsUrl.length) {
      throw new Error("wsUrl entries must be non-empty strings");
    }
  }
  const wsUrl = supervisionUrls ? supervisionUrls[0] : rawWsUrl;
  if (typeof wsUrl !== "string" || wsUrl.length === 0) {
    throw new Error("wsUrl is required (string or non-empty array of strings)");
  }
  // Refused rather than defaulted: a typo like "round_robin" would otherwise
  // succeed and silently give the caller round-robin when they asked for
  // affinity, which is the opposite of the determinism affinity exists for.
  let urlDistribution: ChargePointInitOptions["urlDistribution"];
  if (Object.prototype.hasOwnProperty.call(body, "urlDistribution")) {
    if (
      body.urlDistribution !== "round-robin" &&
      body.urlDistribution !== "random" &&
      body.urlDistribution !== "cp-affinity"
    ) {
      throw new Error(
        'urlDistribution must be "round-robin", "random" or "cp-affinity"',
      );
    }
    urlDistribution = body.urlDistribution;
  }
  // #609: refused rather than defaulted, like urlDistribution — a typo in a
  // reconnect field must not silently leave the default policy in place.
  let transport: ChargePointInitOptions["transport"];
  if (Object.prototype.hasOwnProperty.call(body, "transport")) {
    const parsedTransport = transportConfigSchema.safeParse(body.transport);
    if (!parsedTransport.success) {
      const issue = parsedTransport.error.issues[0];
      throw new Error(
        `transport is invalid: ${issue.path.join(".") || "(root)"}: ${issue.message}`,
      );
    }
    transport = parsedTransport.data;
  }
  const centralSystemUrl =
    typeof body.centralSystemUrl === "string" &&
    body.centralSystemUrl.length > 0
      ? body.centralSystemUrl
      : wsUrl;
  const soapCallbackUrl =
    typeof body.soapCallbackUrl === "string" && body.soapCallbackUrl.length > 0
      ? body.soapCallbackUrl
      : undefined;
  const soapPath =
    typeof body.soapPath === "string" && body.soapPath.startsWith("/")
      ? normalizeSoapPath(body.soapPath)
      : undefined;
  const connectors =
    typeof body.connectors === "number" && Number.isInteger(body.connectors)
      ? body.connectors
      : 1;
  if (connectors < 1) {
    throw new Error("connectors must be >= 1");
  }
  const vendor =
    typeof body.vendor === "string" ? body.vendor : "Server-Vendor";
  const model = typeof body.model === "string" ? body.model : "Server-Model";
  let ocppVersion = "OCPP-1.6J";
  if (Object.prototype.hasOwnProperty.call(body, "ocppVersion")) {
    if (typeof body.ocppVersion !== "string") {
      throw new Error("ocppVersion must be a string");
    }
    if (isOcppVersion(body.ocppVersion)) {
      ocppVersion = body.ocppVersion;
    } else {
      throw new Error("ocppVersion must be a supported OCPP version");
    }
  }
  if (
    isSoapVersion(ocppVersion) &&
    !soapCallbackUrl &&
    !opts.soapCallbackUrlDerivable
  ) {
    throw new Error("soapCallbackUrl is required for OCPP SOAP versions");
  }
  // A SOAP charge point has no reconnect loop to rotate — it posts to the
  // Central System service and the CSMS calls back on one advertised address —
  // so a list would be accepted and then quietly ignored. Refuse it instead.
  if (isSoapVersion(ocppVersion) && supervisionUrls) {
    throw new Error(
      "wsUrl must be a single URL for the OCPP SOAP versions; several supervision URLs are an OCPP-J feature",
    );
  }
  // #611: same reasoning — the SOAP versions have no WebSocket to configure.
  if (transport?.ws && isSoapVersion(ocppVersion)) {
    throw new Error(
      "transport.ws applies to the OCPP-J WebSocket; the SOAP versions have none",
    );
  }
  // Every entry is checked here, not just the first. A later member is only
  // touched at reconnect time, where `buildOcppWebSocketUrl` calls `new URL()`
  // synchronously inside a `setTimeout` callback — a malformed one throws
  // there, uncaught, and takes the daemon down instead of failing over.
  for (const url of supervisionUrls ?? []) {
    if (!isWebSocketUrl(url)) {
      throw new Error(
        `wsUrl entry "${url}" is not a ws:// or wss:// URL; every supervision URL must be usable, since a later one is only reached on reconnect`,
      );
    }
  }

  // The `file` form is resolved here, so what the charge point stores and
  // persists is always the list itself, and a bad path fails the create rather
  // than the first transaction. The path is kept alongside it (#314): without
  // `--watch` nothing re-reads it, but the daemon cannot re-establish a watch
  // for a charge point restored from `--state-db` unless it knows where the
  // list came from.
  let idTags: readonly string[] | undefined;
  let idTagFile: string | undefined;
  let idTagDistribution: ChargePointInitOptions["idTagDistribution"];
  if (isRecord(body.idTagPool)) {
    const pool = body.idTagPool;
    if (
      pool.distribution === "round-robin" ||
      pool.distribution === "random" ||
      pool.distribution === "connector-affinity"
    ) {
      idTagDistribution = pool.distribution;
    } else if (pool.distribution !== undefined) {
      throw new Error(
        'idTagPool.distribution must be "round-robin", "random" or "connector-affinity"',
      );
    }
    if (Array.isArray(pool.tags)) {
      idTags = pool.tags.filter(
        (t): t is string => typeof t === "string" && t.length > 0,
      );
      if (idTags.length !== pool.tags.length) {
        throw new Error("idTagPool.tags entries must be non-empty strings");
      }
    } else if (typeof pool.file === "string" && pool.file.length > 0) {
      // Resolved against the process CWD here, once, and persisted absolute:
      // the read below already resolves it that way, so storing the caller's
      // relative string would have a `--state-db` daemon restarted from another
      // directory re-resolve it somewhere else and watch the wrong file — or
      // nothing at all — while reporting the pool as file-backed.
      const resolvedFile = path.resolve(pool.file);
      idTags = readIdTagsFile(resolvedFile);
      idTagFile = resolvedFile;
    }
    if (!idTags || idTags.length === 0) {
      throw new Error("idTagPool needs a non-empty tags array or a file");
    }
    if (idTags.length > MAX_ID_TAGS) {
      throw new Error(`idTagPool holds at most ${MAX_ID_TAGS} tags`);
    }
  }

  let basicAuth: ChargePointInitOptions["basicAuth"] = null;
  if (isRecord(body.basicAuth)) {
    const username = body.basicAuth.username;
    const password = body.basicAuth.password;
    if (typeof username === "string" && typeof password === "string") {
      basicAuth = { username, password };
    }
  }
  let securityProfile: ChargePointInitOptions["securityProfile"];
  if (Object.prototype.hasOwnProperty.call(body, "securityProfile")) {
    const value = body.securityProfile;
    if (value === 0 || value === 1 || value === 2 || value === 3) {
      securityProfile = value;
    } else {
      throw new Error("securityProfile must be 0, 1, 2, or 3");
    }
  }
  const authorizationKey =
    typeof body.authorizationKey === "string"
      ? body.authorizationKey
      : undefined;
  const cpoName = typeof body.cpoName === "string" ? body.cpoName : undefined;
  const txUpdatedMeterValues =
    typeof body.txUpdatedMeterValues === "boolean"
      ? body.txUpdatedMeterValues
      : undefined;
  let inboundValidation: ChargePointInitOptions["inboundValidation"];
  if (Object.prototype.hasOwnProperty.call(body, "inboundValidation")) {
    if (
      body.inboundValidation !== "off" &&
      body.inboundValidation !== "warn" &&
      body.inboundValidation !== "enforce"
    ) {
      throw new Error('inboundValidation must be "off", "warn" or "enforce"');
    }
    inboundValidation = body.inboundValidation;
  }
  const reservationAuthorizeIdTag =
    typeof body.reservationAuthorizeIdTag === "boolean"
      ? body.reservationAuthorizeIdTag
      : undefined;
  const capabilityProfile = parseCapabilityProfile(body.capabilityProfile);
  let chargerCapabilities: ChargePointInitOptions["chargerCapabilities"];
  if (body.chargerCapabilities !== undefined) {
    const problem = chargerCapabilitiesProblem(body.chargerCapabilities);
    if (problem) throw new Error(problem);
    chargerCapabilities =
      body.chargerCapabilities as ChargePointInitOptions["chargerCapabilities"];
  }
  let modem: ChargePointInitOptions["modem"];
  if (body.modem !== undefined) {
    const problem = modemConfigProblem(body.modem);
    if (problem) throw new Error(problem);
    modem = body.modem as ChargePointInitOptions["modem"];
  }
  const tlsCaPath =
    typeof body.tlsCaPath === "string" ? body.tlsCaPath : undefined;
  const tlsCertPath =
    typeof body.tlsCertPath === "string" ? body.tlsCertPath : undefined;
  const tlsKeyPath =
    typeof body.tlsKeyPath === "string" ? body.tlsKeyPath : undefined;
  let tls: ChargePointInitOptions["tls"];
  if (isRecord(body.tls)) {
    tls = {
      ...(typeof body.tls.ca === "string" ? { ca: body.tls.ca } : {}),
      ...(typeof body.tls.cert === "string" ? { cert: body.tls.cert } : {}),
      ...(typeof body.tls.key === "string" ? { key: body.tls.key } : {}),
      ...(typeof body.tls.rejectUnauthorized === "boolean"
        ? { rejectUnauthorized: body.tls.rejectUnauthorized }
        : {}),
      ...(typeof body.tls.serverName === "string"
        ? { serverName: body.tls.serverName }
        : {}),
    };
  }
  const bn = isRecord(body.bootNotification) ? body.bootNotification : null;
  const bootNotification: ChargePointInitOptions["bootNotification"] = bn
    ? {
        ...(typeof bn.firmwareVersion === "string"
          ? { firmwareVersion: bn.firmwareVersion }
          : {}),
        ...(typeof bn.chargePointSerialNumber === "string"
          ? { chargePointSerialNumber: bn.chargePointSerialNumber }
          : {}),
        ...(typeof bn.chargeBoxSerialNumber === "string"
          ? { chargeBoxSerialNumber: bn.chargeBoxSerialNumber }
          : {}),
        ...(typeof bn.meterSerialNumber === "string"
          ? { meterSerialNumber: bn.meterSerialNumber }
          : {}),
        ...(typeof bn.meterType === "string"
          ? { meterType: bn.meterType }
          : {}),
        ...(typeof bn.iccid === "string" ? { iccid: bn.iccid } : {}),
        ...(typeof bn.imsi === "string" ? { imsi: bn.imsi } : {}),
      }
    : undefined;
  // #446. Absent stays absent so `cp.update` keeps the current labels; a
  // given map (`{}` included) replaces them.
  let behaviors: string[] | undefined;
  if (body.behaviors !== undefined) {
    // Ids only. A string that is not a loaded id fails later, in the
    // registry, with the loaded ids named; it is never read as code or a path.
    const parsed = behaviorIdsSchema.safeParse(body.behaviors);
    if (!parsed.success) {
      throw new Error("behaviors must be an array of behavior ids");
    }
    behaviors = parsed.data;
  }
  let behaviorParams: ChargePointInitOptions["behaviorParams"];
  if (body.behaviorParams !== undefined) {
    // JSON only, bounded; the registry checks each entry against the schema of
    // the behavior it names.
    const parsed = behaviorParamsSchema.safeParse(body.behaviorParams);
    if (!parsed.success) {
      throw new Error(
        "behaviorParams must be an object of behavior id to a JSON object of params",
      );
    }
    behaviorParams = parsed.data as ChargePointInitOptions["behaviorParams"];
  }
  let labels: ChargePointInitOptions["labels"];
  if (body.labels !== undefined) {
    const parsed = labelsSchema.safeParse(body.labels);
    if (!parsed.success) throw new Error("labels must be a valid label map");
    labels = parsed.data;
  }
  return {
    cpId,
    wsUrl,
    centralSystemUrl,
    connectors,
    vendor,
    model,
    basicAuth,
    ocppVersion,
    ...(soapCallbackUrl ? { soapCallbackUrl } : {}),
    ...(soapPath ? { soapPath } : {}),
    ...(supervisionUrls && supervisionUrls.length > 1
      ? { supervisionUrls }
      : {}),
    ...(urlDistribution ? { urlDistribution } : {}),
    ...(transport ? { transport } : {}),
    ...(idTags ? { idTags } : {}),
    ...(idTagFile ? { idTagFile } : {}),
    ...(idTagDistribution ? { idTagDistribution } : {}),
    securityProfile,
    authorizationKey,
    cpoName,
    ...(txUpdatedMeterValues !== undefined ? { txUpdatedMeterValues } : {}),
    ...(inboundValidation ? { inboundValidation } : {}),
    ...(reservationAuthorizeIdTag !== undefined
      ? { reservationAuthorizeIdTag }
      : {}),
    ...(capabilityProfile ? { capabilityProfile } : {}),
    ...(chargerCapabilities ? { chargerCapabilities } : {}),
    ...(modem ? { modem } : {}),
    tls,
    tlsCaPath,
    tlsCertPath,
    tlsKeyPath,
    ...(bootNotification ? { bootNotification } : {}),
    ...(labels !== undefined ? { labels } : {}),
    ...(behaviors !== undefined ? { behaviors } : {}),
    ...(behaviorParams !== undefined ? { behaviorParams } : {}),
  };
}

/** #618: `undefined` when absent, an Error when malformed. */
function parseCapabilityProfile(
  value: unknown,
): ChargePointInitOptions["capabilityProfile"] {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("capabilityProfile must be an object");
  }
  const raw = value as Record<string, unknown>;
  const names = (key: string): string[] | undefined => {
    const list = raw[key];
    if (list === undefined) return undefined;
    if (!Array.isArray(list) || list.some((v) => typeof v !== "string")) {
      throw new Error(`capabilityProfile.${key} must be an array of strings`);
    }
    return list as string[];
  };
  const oneOf = <T extends string>(
    key: string,
    allowed: readonly T[],
  ): T | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
      throw new Error(
        `capabilityProfile.${key} must be one of ${allowed.join(", ")}`,
      );
    }
    return v as T;
  };
  const disabledActions = names("disabledActions");
  const triggerMessageTargets = names("triggerMessageTargets");
  const disabledActionErrorCode = oneOf(
    "disabledActionErrorCode",
    DISABLED_ACTION_ERROR_CODES,
  );
  const statusTransitions = oneOf("statusTransitions", STATUS_TRANSITION_MODES);
  return {
    ...(disabledActions ? { disabledActions } : {}),
    ...(triggerMessageTargets ? { triggerMessageTargets } : {}),
    ...(disabledActionErrorCode ? { disabledActionErrorCode } : {}),
    ...(statusTransitions ? { statusTransitions } : {}),
  };
}
