import {
  type OcppVersion,
  parseOcppVersion,
} from "../../../domain/types/OcppVersion";

export type OcppSubprotocol = "ocpp1.6" | "ocpp2.0.1" | "ocpp2.1";
export const OCPP_WEBSOCKET_PROTOCOL_16: OcppSubprotocol = "ocpp1.6";
export const OCPP_WEBSOCKET_PROTOCOL_201: OcppSubprotocol = "ocpp2.0.1";
export const OCPP_WEBSOCKET_PROTOCOL_21: OcppSubprotocol = "ocpp2.1";

export function subprotocolForVersion(v: OcppVersion): OcppSubprotocol {
  return v === "OCPP-2.1"
    ? OCPP_WEBSOCKET_PROTOCOL_21
    : v === "OCPP-2.0.1"
      ? OCPP_WEBSOCKET_PROTOCOL_201
      : OCPP_WEBSOCKET_PROTOCOL_16;
}

/** Back-compat string entry point - exact prior behavior + signature. */
export function ocppVersionToSubprotocol(raw: string): OcppSubprotocol {
  return subprotocolForVersion(parseOcppVersion(raw));
}
