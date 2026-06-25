import { parseOcppVersion } from "../../../domain/types/OcppVersion";
import { outgoingV16Warning } from "../codec/validateV16";
import { OCPPMessageHandler } from "../OCPPMessageHandler";
import { OCPPMessageHandlerV201 } from "../OCPPMessageHandlerV201";
import {
  OCPP_WEBSOCKET_PROTOCOL_16,
  OCPP_WEBSOCKET_PROTOCOL_201,
  OCPP_WEBSOCKET_PROTOCOL_21,
} from "./subprotocols";
import type { ProtocolCodec, ProtocolProfile } from "./ProtocolProfile";

const v16Codec: ProtocolCodec = {
  outgoingWarning: (action, payload) => outgoingV16Warning(action, payload),
};
const v201Codec: ProtocolCodec = { outgoingWarning: () => null };

const V16_PROFILE: ProtocolProfile = {
  version: "OCPP-1.6J",
  subprotocol: OCPP_WEBSOCKET_PROTOCOL_16,
  codec: v16Codec,
  createMessageHandler: (cp, ws, log) =>
    new OCPPMessageHandler(cp, ws, log, v16Codec),
};

const V201_PROFILE: ProtocolProfile = {
  version: "OCPP-2.0.1",
  subprotocol: OCPP_WEBSOCKET_PROTOCOL_201,
  codec: v201Codec,
  createMessageHandler: (cp, ws, log) =>
    new OCPPMessageHandlerV201(cp, ws, log),
};

// The generated OCPP package has no 2.1 types/schemas yet, so this exposes
// the 2.0.1-compatible subset until 2.1-net-new messages can be modeled.
const V21_PROFILE: ProtocolProfile = {
  version: "OCPP-2.1",
  subprotocol: OCPP_WEBSOCKET_PROTOCOL_21,
  codec: v201Codec,
  createMessageHandler: (cp, ws, log) =>
    new OCPPMessageHandlerV201(cp, ws, log),
};

export function getProtocolProfile(raw: string): ProtocolProfile {
  const version = parseOcppVersion(raw);
  return version === "OCPP-2.1"
    ? V21_PROFILE
    : version === "OCPP-2.0.1"
      ? V201_PROFILE
      : V16_PROFILE;
}
