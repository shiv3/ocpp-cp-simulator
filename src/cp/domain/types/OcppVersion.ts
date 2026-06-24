export type OcppVersion = "OCPP-1.6J" | "OCPP-2.0.1";
export const OCPP_1_6: OcppVersion = "OCPP-1.6J";
export const OCPP_2_0_1: OcppVersion = "OCPP-2.0.1";

/** Mirrors today's rule: anything not exactly "OCPP-2.0.1" is treated as 1.6J. */
export function parseOcppVersion(raw: string | null | undefined): OcppVersion {
  return raw === OCPP_2_0_1 ? OCPP_2_0_1 : OCPP_1_6;
}
