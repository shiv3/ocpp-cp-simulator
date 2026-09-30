/**
 * An expert OCPP call (#389): one station-initiated CALL whose action and
 * payload the operator chose, sent through the normal transport, correlation
 * and logging. The console, the control plane and the scenario `ocppCall`
 * node all go through `ChargePoint.sendOcppCall`.
 */
export interface OcppCallRequest {
  readonly action: string;
  readonly payload: Record<string, unknown>;
  /** Send even when the payload fails the outgoing schema check. Applies to
   *  this CALL only; normal traffic keeps its own check. */
  readonly skipValidation?: boolean;
  /** Also run the answer through the station's normal response handling
   *  (boot, transaction, authorize…). Off by default: the answer is only
   *  logged and returned. */
  readonly applyResponse?: boolean;
}

/** The CSMS's answer. A CALLERROR is an answer too, not a failure: provoking
 *  one is often the point of an interoperability test. `sentFrame` is the
 *  OCPP-J frame exactly as written to the socket. */
export type OcppCallOutcome =
  | {
      readonly kind: "callResult";
      readonly messageId: string;
      readonly sentFrame: string;
      readonly payload: unknown;
    }
  | {
      readonly kind: "callError";
      readonly messageId: string;
      readonly sentFrame: string;
      readonly errorCode: string;
      readonly errorDescription: string;
      readonly errorDetails: unknown;
    };

export type OcppCallRejection =
  /** SOAP (1.2, 1.5, 1.6-S) has no arbitrary-action path. */
  | "unsupported_transport"
  /** Not a station-initiated CALL on the station's OCPP version. */
  | "unsupported_action"
  /** Fails the outgoing schema check and `skipValidation` is not set. */
  | "invalid_payload"
  /** OCPP 1.6 §4.2: BootNotification not yet Accepted. */
  | "boot_gate";

/** How long an expert call waits for the answer. Kept under the Socket.IO
 *  client's RPC timeout (`RPC_TIMEOUT_MS`, 30 s), like
 *  `DATA_TRANSFER_RESPONSE_TIMEOUT_MS`, so a remote caller sees this error
 *  rather than the client's generic timeout. */
export const OCPP_CALL_RESPONSE_TIMEOUT_MS = 25_000;
