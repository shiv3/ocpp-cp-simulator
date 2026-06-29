// Single entry point for the socket.io control-plane protocol. Browser, server,
// and CLI import everything from here. zod is the single source of truth; the
// types below are inferred from the `METHODS` table — no codegen.

import type { z } from "zod";
import { METHODS } from "./methods";

export * from "./limits";
export * from "./errors";
export * from "./events";
export * from "./envelope";
export { METHODS, EXPLICIT_METHODS } from "./methods";

/** Every valid rpc method id. */
export type RpcMethod = keyof typeof METHODS;

/** The validated params type for a given method. */
export type Params<M extends RpcMethod> = z.infer<
  (typeof METHODS)[M]["params"]
>;

/** The result type for a given method. */
export type Result<M extends RpcMethod> = z.infer<
  (typeof METHODS)[M]["result"]
>;

/** True if `id` is a known rpc method. */
export function isRpcMethod(id: string): id is RpcMethod {
  return Object.prototype.hasOwnProperty.call(METHODS, id);
}
