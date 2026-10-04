import { buildSoapCallbackUrl } from "../cli/soapCallbackUrl";
import type { ServerInfo } from "../protocol";
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
  tls?: OcppTlsOptions;
  tlsCaPath?: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
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
