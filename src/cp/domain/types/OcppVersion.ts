export type OcppVersion = "OCPP-1.6J" | "OCPP-2.0.1" | "OCPP-2.1";
export const OCPP_1_6: OcppVersion = "OCPP-1.6J";
export const OCPP_2_0_1: OcppVersion = "OCPP-2.0.1";
export const OCPP_2_1: OcppVersion = "OCPP-2.1";

/** Exact supported versions are preserved; unknown values keep the legacy 1.6J fallback. */
export function parseOcppVersion(raw: string | null | undefined): OcppVersion {
  if (raw === OCPP_2_1) return OCPP_2_1;
  if (raw === OCPP_2_0_1) return OCPP_2_0_1;
  return OCPP_1_6;
}
