// Wire schemas + redaction for the socket.io control plane.
//
// SECURITY (Sec-2): every outbound CP-config surface goes through `redactCp`
// and the `WireCpConfig` type, which STRUCTURALLY has no `basicAuth.password`
// and strips embedded `user:pass@` credentials from `wsUrl`. `WireCpConfig` is
// the canonical wire type; the daemon's full config (with secrets) never
// reaches the wire. CLIEvents (`event`/`data`) do not carry CP config, but
// `eventToWire` still defensively deep-strips sensitive keys such as
// `password` and `AuthorizationKey` as a belt-and-suspenders guard.

import { z } from "zod";
import { redactSensitiveValue } from "../cp/shared/redaction";
import { OBJ_MAX_BYTES, STR_64K, boundedObject } from "./limits";
import type { OcppSecurityProfile } from "../cp/infrastructure/transport/wsUrlWithBasic";

// ---------------------------------------------------------------------------
// Redaction helpers
// ---------------------------------------------------------------------------

/** Strip any embedded `user:pass@` credentials from a URL. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return url.replace(/\/\/[^@/]*@/, "//");
  }
}

interface FullBootNotification {
  firmwareVersion?: string;
  chargePointSerialNumber?: string;
  chargeBoxSerialNumber?: string;
  meterSerialNumber?: string;
  meterType?: string;
  iccid?: string;
  imsi?: string;
}

interface FullCpConfig {
  wsUrl: string;
  centralSystemUrl?: string;
  soapCallbackUrl?: string;
  soapPath?: string;
  ocppVersion?: string;
  connectors: number;
  vendor: string;
  model: string;
  basicAuth: { username: string; password?: string } | null;
  securityProfile?: OcppSecurityProfile;
  cpoName?: string;
  tlsCaPath?: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  bootNotification: FullBootNotification | null;
}

/**
 * Map a full CP config (with secrets) to the redacted `WireCpConfig`:
 * password dropped, wsUrl credentials stripped.
 */
export function redactCp(config: FullCpConfig): WireCpConfig {
  return {
    wsUrl: redactUrl(config.wsUrl),
    centralSystemUrl: config.centralSystemUrl
      ? redactUrl(config.centralSystemUrl)
      : undefined,
    soapCallbackUrl: config.soapCallbackUrl
      ? redactUrl(config.soapCallbackUrl)
      : undefined,
    soapPath: config.soapPath,
    ocppVersion: config.ocppVersion,
    connectors: config.connectors,
    vendor: config.vendor,
    model: config.model,
    basicAuth: config.basicAuth
      ? { username: config.basicAuth.username }
      : null,
    securityProfile: config.securityProfile,
    cpoName: config.cpoName,
    tlsCaPath: config.tlsCaPath,
    tlsCertPath: config.tlsCertPath,
    tlsKeyPath: config.tlsKeyPath,
    bootNotification: config.bootNotification ?? null,
  };
}

// ---------------------------------------------------------------------------
// WireCpConfig — the ONLY outbound CP-config type (no password)
// ---------------------------------------------------------------------------

export const bootNotificationWireSchema = z
  .object({
    firmwareVersion: STR_64K.optional(),
    chargePointSerialNumber: STR_64K.optional(),
    chargeBoxSerialNumber: STR_64K.optional(),
    meterSerialNumber: STR_64K.optional(),
    meterType: STR_64K.optional(),
    iccid: STR_64K.optional(),
    imsi: STR_64K.optional(),
  })
  .strict()
  .nullable();

export const wireCpConfigSchema = z
  .object({
    wsUrl: STR_64K,
    centralSystemUrl: STR_64K.optional(),
    soapCallbackUrl: STR_64K.optional(),
    soapPath: STR_64K.optional(),
    ocppVersion: STR_64K.optional(),
    connectors: z.number().int().min(0),
    vendor: STR_64K,
    model: STR_64K,
    basicAuth: z.object({ username: STR_64K }).strict().nullable(),
    securityProfile: z
      .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
      .optional(),
    cpoName: STR_64K.optional(),
    tlsCaPath: STR_64K.optional(),
    tlsCertPath: STR_64K.optional(),
    tlsKeyPath: STR_64K.optional(),
    bootNotification: bootNotificationWireSchema,
  })
  .strict();
export type WireCpConfig = z.infer<typeof wireCpConfigSchema>;

// ---------------------------------------------------------------------------
// WireSimulatorConfig — persisted simulator config reads (no password)
// ---------------------------------------------------------------------------

const wireSimulatorBootNotificationSchema = z
  .object({
    chargePointVendor: STR_64K,
    chargePointModel: STR_64K,
    chargePointSerialNumber: STR_64K.optional(),
    chargeBoxSerialNumber: STR_64K.optional(),
    firmwareVersion: STR_64K.optional(),
    iccid: STR_64K.optional(),
    imsi: STR_64K.optional(),
    meterType: STR_64K.optional(),
    meterSerialNumber: STR_64K.optional(),
  })
  .strict()
  .nullable();

const wireBasicAuthSettingsSchema = z
  .object({
    enabled: z.boolean(),
    username: STR_64K,
  })
  .strict();

const simulatorConfigBaseSchema = z
  .object({
    wsURL: STR_64K,
    ChargePointID: STR_64K,
    connectorNumber: z.number().int().min(0),
    tagID: STR_64K,
    ocppVersion: STR_64K,
    basicAuthSettings: wireBasicAuthSettingsSchema,
    autoMeterValueSetting: z
      .object({
        enabled: z.boolean(),
        interval: z.number(),
        value: z.number(),
      })
      .strict(),
    Experimental: z
      .object({
        ChargePointIDs: z
          .array(
            z
              .object({
                ChargePointID: STR_64K,
                ConnectorNumber: z.number().int().min(0),
              })
              .strict(),
          )
          .max(1_000),
        TagIDs: z.array(STR_64K).max(1_000),
      })
      .strict()
      .nullable(),
    BootNotification: wireSimulatorBootNotificationSchema,
  })
  .strict();

export const wireSimulatorConfigSchema = simulatorConfigBaseSchema;
export type WireSimulatorConfig = z.infer<typeof wireSimulatorConfigSchema>;

export const simulatorConfigInputSchema = simulatorConfigBaseSchema.extend({
  basicAuthSettings: wireBasicAuthSettingsSchema
    .extend({ password: STR_64K.optional() })
    .strict(),
  BootNotification: boundedObject(OBJ_MAX_BYTES)
    .nullable()
    .pipe(wireSimulatorBootNotificationSchema),
});
export type SimulatorConfigInput = z.infer<typeof simulatorConfigInputSchema>;

interface FullSimulatorConfig extends SimulatorConfigInput {
  basicAuthSettings: SimulatorConfigInput["basicAuthSettings"] & {
    password?: string;
  };
}

export function redactSimulatorConfig(
  config: FullSimulatorConfig,
): WireSimulatorConfig {
  return {
    ...config,
    wsURL: redactUrl(config.wsURL),
    basicAuthSettings: {
      enabled: config.basicAuthSettings.enabled,
      username: config.basicAuthSettings.username,
    },
  };
}

// ---------------------------------------------------------------------------
// Status (per-CP snapshot) — config redacted via WireCpConfig
// ---------------------------------------------------------------------------

export const connectorStatusWireSchema = z
  .object({
    id: z.number().int().min(0),
    status: STR_64K,
    availability: STR_64K,
    meterValue: z.number(),
    transactionId: z.number().nullable(),
    soc: z.number().nullable(),
    mode: STR_64K,
    autoResetToAvailable: z.boolean(),
    autoMeterValueConfig: z.record(z.string(), z.unknown()).nullable(),
    evSettings: z.record(z.string(), z.unknown()).nullable(),
    chargingProfile: z.record(z.string(), z.unknown()).nullable(),
    chargingProfiles: z.array(z.record(z.string(), z.unknown())).max(1_000),
    transactionStartTime: z.string().nullable(),
    transactionTagId: z.string().nullable(),
    transactionBatteryCapacityKwh: z.number().nullable(),
  })
  .strict();

export const statusWireSchema = z
  .object({
    id: STR_64K,
    status: STR_64K,
    error: STR_64K,
    connectors: z.array(connectorStatusWireSchema).max(1_000),
    heartbeat: z
      .object({
        intervalSeconds: z.number(),
        lastSentAt: z.string().nullable(),
      })
      .strict()
      .optional(),
    config: wireCpConfigSchema.optional(),
  })
  .strict();
export type StatusWire = z.infer<typeof statusWireSchema>;

interface FullStatus {
  id: string;
  status: string;
  error: string;
  // Passed straight through (validated separately by statusWireSchema), so we
  // accept any connector shape — the daemon's ConnectorStatus has no index
  // signature and would otherwise not be assignable to Record<string, unknown>.
  connectors: ReadonlyArray<unknown>;
  heartbeat?: { intervalSeconds: number; lastSentAt: string | null };
  config?: FullCpConfig;
}

/** Map `service.getStatus()` → wire status with the embedded config redacted. */
export function statusToWire(status: FullStatus): StatusWire {
  return {
    id: status.id,
    status: status.status,
    error: status.error,
    connectors: status.connectors as StatusWire["connectors"],
    heartbeat: status.heartbeat,
    config: status.config ? redactCp(status.config) : undefined,
  };
}

// ---------------------------------------------------------------------------
// CpListItem + registry cp push
// ---------------------------------------------------------------------------

export const cpListItemSchema = wireCpConfigSchema.extend({
  cpId: STR_64K,
  status: STR_64K,
});
export type CpListItem = z.infer<typeof cpListItemSchema>;

interface FullCp {
  id: string;
  status: string;
  config: FullCpConfig;
}

/** The ONLY constructor for a registry `cp` push payload (structurally redacted). */
export function registryCpToWire(cp: FullCp): CpListItem {
  return { ...redactCp(cp.config), cpId: cp.id, status: cp.status };
}

// ---------------------------------------------------------------------------
// CLIEvent wire form
// ---------------------------------------------------------------------------

export const cliEventWireSchema = z
  .object({
    event: z.string().max(128),
    data: z.unknown(),
    timestamp: z.string().optional(),
  })
  .strict();
export type CliEventWire = z.infer<typeof cliEventWireSchema>;

const URL_WITH_CREDS = /^[a-zA-Z][\w+.-]*:\/\/[^@/]*@/;
const TLS_MATERIAL_KEY_NAMES = new Set([
  "ca",
  "cert",
  "certificate",
  "key",
  "passphrase",
  "privatekey",
]);

/**
 * Defensively redact event data: drop sensitive keys AND strip embedded
 * `user:pass@` credentials from any URL-shaped string value. CLIEvents do not
 * carry CP config today, so this is belt-and-suspenders (B-1).
 */
function deepRedact(value: unknown): unknown {
  const withoutSecrets = redactSensitiveValue(value);
  if (typeof withoutSecrets === "string") {
    return URL_WITH_CREDS.test(withoutSecrets)
      ? redactUrl(withoutSecrets)
      : withoutSecrets;
  }
  if (Array.isArray(withoutSecrets)) return withoutSecrets.map(deepRedact);
  if (withoutSecrets && typeof withoutSecrets === "object") {
    return Object.fromEntries(
      Object.entries(withoutSecrets as Record<string, unknown>).map(
        ([k, v]) => [
          k,
          normalizedKey(k) === "tls" ? redactTlsMaterial(v) : deepRedact(v),
        ],
      ),
    );
  }
  return withoutSecrets;
}

function redactTlsMaterial(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactTlsMaterial);
  if (!value || typeof value !== "object") return deepRedact(value);

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !TLS_MATERIAL_KEY_NAMES.has(normalizedKey(key)))
      .map(([key, nested]) => [key, redactTlsMaterial(nested)]),
  );
}

function normalizedKey(key: string): string {
  return key.replace(/[-_]/g, "").toLowerCase();
}

/** Bound + defensively redact a CLIEvent for the wire. */
export function eventToWire(evt: {
  event: string;
  data: unknown;
  timestamp?: string;
}): CliEventWire {
  return {
    event: evt.event,
    data: deepRedact(evt.data),
    timestamp: evt.timestamp,
  };
}
