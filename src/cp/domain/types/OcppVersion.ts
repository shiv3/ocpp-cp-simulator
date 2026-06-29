export const OCPP_1_5 = "OCPP-1.5";
export const OCPP_1_6 = "OCPP-1.6J";
export const OCPP_2_0_1 = "OCPP-2.0.1";
export const OCPP_2_1 = "OCPP-2.1";

export const SUPPORTED_OCPP_VERSIONS = [
  OCPP_1_5,
  OCPP_1_6,
  OCPP_2_0_1,
  OCPP_2_1,
] as const;

export type OcppVersion = (typeof SUPPORTED_OCPP_VERSIONS)[number];

export function isOcppVersion(raw: string): raw is OcppVersion {
  return (SUPPORTED_OCPP_VERSIONS as readonly string[]).includes(raw);
}

/** Exact supported versions are preserved; unknown values keep the legacy 1.6J fallback. */
export function parseOcppVersion(raw: string | null | undefined): OcppVersion {
  if (raw && isOcppVersion(raw)) return raw;
  return OCPP_1_6;
}
