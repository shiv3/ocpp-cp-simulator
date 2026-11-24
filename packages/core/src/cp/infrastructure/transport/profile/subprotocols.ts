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

/**
 * What the CSMS selected after the upgrade, against what was offered (#1061).
 *
 * OCPP-J Part 4 §3.1.2 (OCPP-J 1.6 §3.1.2; Part 4 of 2.0.1 / 2.1) governs the
 * `Sec-WebSocket-Protocol` negotiation. That text is not in the offline
 * specification set, so it is not quoted here. What the set does say is
 * TC_B_58 (Part 6 of 2.0.1 and 2.1): "OCPP-J imposes extra constraints on the
 * WebSocket subprotocol, detailed in the following section 3.1.2", and the
 * upgrade response "must contain the header Sec-Websocket-Protocol",
 * formatted as `Sec-WebSocket-Protocol: ocpp<Selected OCPP version>`. The
 * station-side rule is not spelled out there, so the conservative reading is
 * taken: a connection with no agreed OCPP version is not used (closed 1002).
 *
 * Offering nothing (`ws.subprotocols: []`) leaves nothing to select, so an
 * empty selection is then expected. Names are compared exactly, as RFC 6455
 * §4.1 does.
 */
export type SelectedSubprotocolCheck =
  | { readonly kind: "matched" | "none-offered" }
  | { readonly kind: "missing" | "mismatch"; readonly message: string };

export function checkSelectedSubprotocol(
  offered: ReadonlyArray<string>,
  selected: string,
): SelectedSubprotocolCheck {
  if (offered.length === 0) return { kind: "none-offered" };
  const list = offered.join(", ");
  if (selected === "") {
    return {
      kind: "missing",
      message: `The CSMS selected no WebSocket subprotocol (offered: ${list})`,
    };
  }
  if (!offered.includes(selected)) {
    return {
      kind: "mismatch",
      message: `The CSMS selected the WebSocket subprotocol "${selected}", which was not offered (offered: ${list})`,
    };
  }
  return { kind: "matched" };
}
