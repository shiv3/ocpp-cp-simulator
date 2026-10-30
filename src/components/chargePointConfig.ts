import { buildSoapCallbackUrl } from "../cli/soapCallbackUrl";
import type { ServerInfo } from "../protocol";
import {
  LABELS_MAX_ENTRIES,
  labelKeySchema,
  labelValueSchema,
  type Labels,
} from "../protocol/labels";
import {
  OCPP_1_2,
  OCPP_1_5,
  OCPP_1_6,
  OCPP_1_6_SOAP,
  OCPP_2_0_1,
  OCPP_2_1,
  isSoapVersion,
} from "../cp/domain/types/OcppVersion";
import type {
  OcppSecurityProfile,
  OcppTlsOptions,
} from "../cp/infrastructure/transport/wsUrlWithBasic";

/*
 * The charge point configuration shape and its pure helpers, shared by the
 * edit form (`ChargePointConfigForm`), its dialog wrapper
 * (`ChargePointConfigModal`, which re-exports everything here for the existing
 * importers) and the callers that build a config. A plain module so the two
 * component files keep exporting components only.
 */

export interface ChargePointConfig {
  cpId: string;
  connectorNumber: number;
  wsURL: string;
  ocppVersion: string;
  basicAuthEnabled: boolean;
  basicAuthUsername: string;
  basicAuthPassword: string;
  autoMeterValueEnabled: boolean;
  autoMeterValueInterval: number;
  autoMeterValue: number;
  chargePointVendor: string;
  chargePointModel: string;
  firmwareVersion: string;
  chargeBoxSerialNumber: string;
  chargePointSerialNumber: string;
  meterSerialNumber: string;
  meterType: string;
  iccid: string;
  imsi: string;
  soapCallbackUrl?: string;
  /** The daemon derived `soapCallbackUrl` from its SOAP public base; the
   *  form shows it as a preview and never sends it back (#183). */
  soapCallbackUrlDerived?: boolean;
  soapPath?: string;
  securityProfile?: OcppSecurityProfile;
  authorizationKey?: string;
  cpoName?: string;
  /** #347: no form input; carried so an edit sends back what it read. */
  txUpdatedMeterValues?: boolean;
  tls?: OcppTlsOptions;
  tlsCaPath?: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  /**
   * Operator labels (#446). Remote mode only, set when the charge point is
   * created; an edit never sends them (#471). `undefined` means none given.
   */
  labels?: Labels;
}

/** One key/value row of the labels editor; may be incomplete while typed. */
export interface LabelRow {
  key: string;
  value: string;
}

export function labelRowsFromMap(labels: Labels | undefined): LabelRow[] {
  return Object.entries(labels ?? {}).map(([key, value]) => ({ key, value }));
}

/**
 * The label map the rows describe, or the first reason they do not describe
 * one. Keys are trimmed and fully blank rows ignored; values are kept as typed
 * (an empty value is a valid label). Validated against the wire schema's own
 * key and value rules, so the form cannot accept what `cp.update` refuses.
 */
export function labelMapFromRows(
  rows: readonly LabelRow[],
): { labels: Record<string, string> } | { error: string } {
  const labels: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key && !row.value) continue;
    if (!key) return { error: `Label value “${row.value}” has no key.` };
    if (!labelKeySchema.safeParse(key).success) {
      return {
        error: `Invalid label key “${key}”. ${labelKeySchema.description}.`,
      };
    }
    if (!labelValueSchema.safeParse(row.value).success) {
      return { error: `Label “${key}” has a value that is too long.` };
    }
    if (Object.hasOwn(labels, key)) {
      return { error: `Label key “${key}” is used twice.` };
    }
    labels[key] = row.value;
  }
  if (Object.keys(labels).length > LABELS_MAX_ENTRIES) {
    return { error: `At most ${LABELS_MAX_ENTRIES} labels.` };
  }
  return { labels };
}

/** The transport a charge point speaks; the first of the form's two selectors. */
export type OcppProtocol = "JSON" | "SOAP";

export interface OcppVersionOption {
  /** The stored `ocppVersion` string (unchanged by the two-selector form). */
  value: string;
  /** The bare version, as the Version select shows it. */
  label: string;
}

/** The versions each protocol offers, in the order the Version select lists them. */
export const OCPP_VERSION_OPTIONS: Readonly<
  Record<OcppProtocol, readonly OcppVersionOption[]>
> = {
  JSON: [
    { value: OCPP_1_6, label: "OCPP 1.6" },
    { value: OCPP_2_0_1, label: "OCPP 2.0.1" },
    { value: OCPP_2_1, label: "OCPP 2.1" },
  ],
  SOAP: [
    { value: OCPP_1_2, label: "OCPP 1.2" },
    { value: OCPP_1_5, label: "OCPP 1.5" },
    { value: OCPP_1_6_SOAP, label: "OCPP 1.6" },
  ],
};

export const OCPP_PROTOCOLS: readonly OcppProtocol[] = ["JSON", "SOAP"];

/** The protocol a stored version belongs to (an unknown value reads as JSON, like the 1.6J fallback). */
export function protocolOf(version: string | undefined): OcppProtocol {
  return isSoapVersion(version) ? "SOAP" : "JSON";
}

export function versionsOfProtocol(
  protocol: OcppProtocol,
): readonly OcppVersionOption[] {
  return OCPP_VERSION_OPTIONS[protocol];
}

/**
 * The version to store when `version` is switched to `protocol`: itself when
 * it already belongs there, else the entry of the same number (1.6 JSON <->
 * 1.6 SOAP), else the protocol's first entry.
 */
export function versionForProtocol(
  version: string,
  protocol: OcppProtocol,
): string {
  const options = OCPP_VERSION_OPTIONS[protocol];
  if (options.some((o) => o.value === version)) return version;
  const current = Object.values(OCPP_VERSION_OPTIONS)
    .flat()
    .find((o) => o.value === version);
  const sameNumber = current && options.find((o) => o.label === current.label);
  return (sameNumber ?? options[0]).value;
}

export type SoapPublicBase = ServerInfo["soap"];

/** The URL the daemon will derive — same helper the registry uses. */
export function previewDerivedSoapCallbackUrl(
  base: SoapPublicBase | null | undefined,
  cpId: string,
  soapPath: string | undefined,
): string | null {
  if (!base?.publicBaseUrl) return null;
  return buildSoapCallbackUrl(
    base.publicBaseUrl,
    cpId,
    soapPath?.trim() || base.path,
  );
}

/** "ngrok tunnel" / "SOAP public base" — where a derived URL comes from. */
export function describeSoapPublicBase(
  base: SoapPublicBase | null | undefined,
): string {
  return base?.tunnel ? `${base.tunnel.provider} tunnel` : "SOAP public base";
}

/**
 * Strip blank secret-ish fields before handing the config to `onSave`.
 * Remote mode's cp.update merge only preserves a field that is entirely
 * *absent* from the request params (see socketServer.ts's
 * `mergeUpdateParams`), so a blank input here must become `undefined` (not
 * `""`) — otherwise "leave blank to keep current" would silently wipe the
 * daemon's stored authorizationKey / TLS cert / TLS key on every edit.
 */
export function sanitizeChargePointConfigForSave(
  config: ChargePointConfig,
): ChargePointConfig {
  return {
    ...config,
    soapCallbackUrl: config.soapCallbackUrl?.trim() || undefined,
    soapPath: config.soapPath?.trim() || undefined,
    authorizationKey: config.authorizationKey?.trim() || undefined,
    tls: sanitizeTlsForSave(config.tls),
  };
}

function sanitizeTlsForSave(
  tls: OcppTlsOptions | undefined,
): OcppTlsOptions | undefined {
  if (!tls) return undefined;
  const result: OcppTlsOptions = {
    ...(tls.ca?.trim() ? { ca: tls.ca } : {}),
    ...(tls.cert?.trim() ? { cert: tls.cert } : {}),
    ...(tls.key?.trim() ? { key: tls.key } : {}),
    ...(tls.serverName?.trim() ? { serverName: tls.serverName } : {}),
    ...(tls.rejectUnauthorized !== undefined
      ? { rejectUnauthorized: tls.rejectUnauthorized }
      : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

export const defaultChargePointConfig: ChargePointConfig = {
  cpId: "CP001",
  connectorNumber: 1,
  wsURL: "ws://localhost:8080/steve/websocket/CentralSystemService/",
  ocppVersion: "OCPP-1.6J",
  basicAuthEnabled: false,
  basicAuthUsername: "",
  basicAuthPassword: "",
  autoMeterValueEnabled: false,
  autoMeterValueInterval: 30,
  autoMeterValue: 10,
  chargePointVendor: "Vendor",
  chargePointModel: "Model",
  firmwareVersion: "1.0",
  chargeBoxSerialNumber: "123456",
  chargePointSerialNumber: "123456",
  meterSerialNumber: "123456",
  meterType: "",
  iccid: "",
  imsi: "",
  securityProfile: 0,
};
