import { parseOcppVersion } from "../../../domain/types/OcppVersion";
import { outgoingV16Warning } from "../codec/validateV16";
import { outgoingV201Warning } from "../codec/validateV201";
import { outgoingV21Warning } from "../codec/validateV21";
import { OCPPMessageHandler } from "../OCPPMessageHandler";
import { OCPPMessageHandlerV201 } from "../OCPPMessageHandlerV201";
import { buildV21InboundRegistry } from "../v21/inboundRegistryV21";
import {
  OCPP_WEBSOCKET_PROTOCOL_16,
  OCPP_WEBSOCKET_PROTOCOL_201,
  OCPP_WEBSOCKET_PROTOCOL_21,
} from "./subprotocols";
import type { ProtocolCodec, ProtocolProfile } from "./ProtocolProfile";

const v16Codec: ProtocolCodec = {
  outgoingWarning: (action, payload) => outgoingV16Warning(action, payload),
};
const v201Codec: ProtocolCodec = { outgoingWarning: outgoingV201Warning };
const v21Codec: ProtocolCodec = { outgoingWarning: outgoingV21Warning };

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
    new OCPPMessageHandlerV201(cp, ws, log, undefined, v201Codec),
};

const V21_PROFILE: ProtocolProfile = {
  version: "OCPP-2.1",
  subprotocol: OCPP_WEBSOCKET_PROTOCOL_21,
  codec: v21Codec,
  createMessageHandler: (cp, ws, log) =>
    new OCPPMessageHandlerV201(
      cp,
      ws,
      log,
      buildV21InboundRegistry(),
      v21Codec,
    ),
};

export function getProtocolProfile(raw: string): ProtocolProfile {
  const version = parseOcppVersion(raw);
  return version === "OCPP-2.1"
    ? V21_PROFILE
    : version === "OCPP-2.0.1"
      ? V201_PROFILE
      : V16_PROFILE;
}
