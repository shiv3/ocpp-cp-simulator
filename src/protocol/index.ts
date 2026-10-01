// Single entry point for the socket.io control-plane protocol. Browser, server,
// and CLI import everything from here. zod is the single source of truth; the
// types below are inferred from the `METHODS` table — no codegen.

import type { z } from "zod";
import { METHODS } from "./methods";

export * from "./limits";
export * from "./errors";
export * from "./events";
export * from "./envelope";
export {
  METHODS,
  EXPLICIT_METHODS,
  createParamsSchema,
  createManyParamsSchema,
  expandIdPattern,
  hasIdPatternPlaceholder,
  MAX_GENERATED_CP_ID_LENGTH,
  blueprintSchema,
  createManyFromBlueprintSchema,
  createManyToolSchema,
  dataTransferDataSchema,
  scenarioWaitExtensionSecondsSchema,
  serverInfoSchema,
  SCENARIO_MODES,
  SCENARIO_RUNS_PAGE_DEFAULT,
  SCENARIO_RUNS_PAGE_MAX,
} from "./methods";
export type { Blueprint, ServerInfo } from "./methods";

/** Every valid rpc method id. */
export type RpcMethod = keyof typeof METHODS;

/** The validated params type for a given method. */
export type Params<M extends RpcMethod> = z.infer<
  (typeof METHODS)[M]["params"]
>;

/**
 * A method paired with its validated params, as a discriminated union: a
 * `switch (call.method)` narrows `call.params` to that method's schema, so a
 * field renamed in `METHODS` breaks its handler at type-check time.
 */
export type RpcCall = {
  [M in RpcMethod]: { readonly method: M; readonly params: Params<M> };
}[RpcMethod];

/** The result type for a given method. */
export type Result<M extends RpcMethod> = z.infer<
  (typeof METHODS)[M]["result"]
>;

/** True if `id` is a known rpc method. */
export function isRpcMethod(id: string): id is RpcMethod {
  return Object.prototype.hasOwnProperty.call(METHODS, id);
}
