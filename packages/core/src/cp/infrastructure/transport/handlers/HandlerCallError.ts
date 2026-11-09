import type { OCPPErrorCodeV16 } from "@ocpp-cp-simulator/ocpp/index";

/**
 * Thrown by a 1.6J CALL handler to answer with a CALLERROR (OCPP-J 1.6
 * §4.2.3) instead of a CALLRESULT, for a request the station does not
 * support at all (`NotSupported`). `OCPPMessageHandler.handleCall` turns it
 * into the CALLERROR; any other exception stays an `InternalError`.
 */
export class HandlerCallError extends Error {
  constructor(
    readonly errorCode: OCPPErrorCodeV16,
    readonly description: string,
  ) {
    super(description);
    this.name = "HandlerCallError";
  }
}
