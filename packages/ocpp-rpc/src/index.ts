// The public entry point of @ocpp-cp-simulator/ocpp-rpc (#978): the OCPP-J
// frame codec and a role-agnostic RPC endpoint, with no simulator domain.
// Runs in Bun and the browser; the only workspace dependency is
// @ocpp-cp-simulator/ocpp, for the schema validator.

export {
  OCPPMessageType,
  decodeFrame,
  encodeCall,
  encodeCallError,
  encodeCallResult,
  encodeCallResultError,
  encodeSend,
  type DecodeFrameOptions,
  type RpcCallErrorFrame,
  type RpcCallFrame,
  type RpcCallResultErrorFrame,
  type RpcCallResultFrame,
  type RpcDecodeError,
  type RpcDecodeErrorReason,
  type RpcFrame,
  type RpcSendFrame,
} from "./frames";
export { CallWaiters } from "./CallWaiters";
export { platformClock, type RpcClock } from "./platformClock";
export {
  OCPP16_RPC_DIALECT,
  OCPP2X_RPC_DIALECT,
  type RpcDialect,
} from "./dialects";
export { violationKind, type ViolationKind } from "./violationKind";
export {
  ocppSchemaValidator,
  type OcppSchemaVersion,
  type RpcValidationTarget,
  type RpcValidator,
  type RpcViolation,
} from "./validation";
export {
  RpcCallError,
  RpcClosedError,
  RpcEndpoint,
  RpcHandlerError,
  RpcInvalidResponseError,
  RpcTimeoutError,
  type RpcEndpointOptions,
  type RpcHandler,
  type RpcProtocolProblem,
} from "./RpcEndpoint";
