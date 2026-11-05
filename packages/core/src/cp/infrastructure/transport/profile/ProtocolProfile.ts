import type { OcppVersion } from "../../../domain/types/OcppVersion";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { Logger } from "../../../shared/Logger";
import type { IChargePointMessageHandler } from "../IChargePointMessageHandler";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import type { OcppSubprotocol } from "./subprotocols";

export interface ProtocolCodec {
  /** Warn-only outbound validation: warning string if invalid, else null. */
  outgoingWarning(action: string, payload: unknown): string | null;
}

export interface ProtocolProfile {
  readonly version: OcppVersion;
  readonly subprotocol: OcppSubprotocol;
  readonly codec: ProtocolCodec;
  createMessageHandler(
    chargePoint: ChargePoint,
    webSocket: OCPPWebSocket,
    logger: Logger,
  ): IChargePointMessageHandler;
}
