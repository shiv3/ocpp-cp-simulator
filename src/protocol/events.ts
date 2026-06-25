// Wire schemas + redaction for the socket.io control plane.
//
// SECURITY (Sec-2): every outbound CP-config surface goes through `redactCp`
// and the `WireCpConfig` type, which STRUCTURALLY has no `basicAuth.password`
// and strips embedded `user:pass@` credentials from `wsUrl`. `WireCpConfig` is
// the canonical wire type; the daemon's full config (with secrets) never
// reaches the wire. CLIEvents (`event`/`data`) do not carry CP config, but
// `eventToWire` still defensively deep-strips any `password` key as a
// belt-and-suspenders guard.

import { z } from "zod";
import { STR_64K } from "./limits";

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
  ocppVersion?: string;
  connectors: number;
  vendor: string;
  model: string;
  basicAuth: { username: string; password?: string } | null;
  bootNotification: FullBootNotification | null;
}

/**
 * Map a full CP config (with secrets) to the redacted `WireCpConfig`:
 * password dropped, wsUrl credentials stripped.
 */
export function redactCp(config: FullCpConfig): WireCpConfig {
  return {
    wsUrl: redactUrl(config.wsUrl),
    ocppVersion: config.ocppVersion,
    connectors: config.connectors,
    vendor: config.vendor,
    model: config.model,
    basicAuth: config.basicAuth
      ? { username: config.basicAuth.username }
      : null,
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
    ocppVersion: STR_64K.optional(),
    connectors: z.number().int().min(0),
    vendor: STR_64K,
    model: STR_64K,
    basicAuth: z.object({ username: STR_64K }).strict().nullable(),
    bootNotification: bootNotificationWireSchema,
  })
  .strict();
export type WireCpConfig = z.infer<typeof wireCpConfigSchema>;

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

/**
 * Defensively redact event data: drop any `password` key AND strip embedded
 * `user:pass@` credentials from any URL-shaped string value. CLIEvents do not
 * carry CP config today, so this is belt-and-suspenders (B-1).
 */
function deepRedact(value: unknown): unknown {
  if (typeof value === "string") {
    return URL_WITH_CREDS.test(value) ? redactUrl(value) : value;
  }
  if (Array.isArray(value)) return value.map(deepRedact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "password") continue;
      out[k] = deepRedact(v);
    }
    return out;
  }
  return value;
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
