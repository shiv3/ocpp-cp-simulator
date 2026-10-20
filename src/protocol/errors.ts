// Closed error-code union + the rpc request/ack envelope schemas for the
// socket.io control plane. The error union is intentionally small and closed so
// both server and client agree on every failure mode; `timeout`/`disconnected`
// are client-synthesised when an ack never arrives (see the rpc wrapper).

import { z } from "zod";

export const RPC_ERROR_CODES = [
  "not_found",
  "invalid_params",
  "internal",
  // #286: a CSMS that refuses the WebSocket upgrade is not the server
  // breaking. `connect` used to report `internal` for it, which sent the
  // reader looking for a daemon fault while the daemon was working correctly
  // and the retry loop was already running. The message carries the close
  // code and reason; the HTTP status, when it can be had, is logged by the
  // transport (#288).
  "connect_failed",
  "unauthorized",
  "timeout",
  "disconnected",
  // #458: an upstream service the daemon calls on the client's behalf (the
  // vehicle catalog) refused for now or failed. Neither is the daemon
  // breaking, and a client that retries needs to tell them from `internal`.
  "rate_limited",
  "unavailable",
] as const;

export const rpcErrorCodeSchema = z.enum(RPC_ERROR_CODES);
export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number];

export const rpcErrorSchema = z.object({
  code: rpcErrorCodeSchema,
  // Human-readable; MUST NOT contain credentials (Sec-2 / non-leakage).
  message: z.string().max(2_000),
  /** `rate_limited` only, when the upstream said how long to wait. */
  retryAfterSeconds: z.number().int().min(0).optional(),
});
export type RpcError = z.infer<typeof rpcErrorSchema>;

/** Thrown by the client rpc wrapper; carries a typed `code`. */
export class RpcFailure extends Error {
  readonly code: RpcErrorCode;
  /** See {@link RpcError.retryAfterSeconds}. */
  readonly retryAfterSeconds: number | undefined;
  constructor(
    code: RpcErrorCode,
    message: string,
    options: { retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = "RpcFailure";
    this.code = code;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** Client → server: `socket.emit("rpc", request, ack)`. */
export const rpcRequestSchema = z.object({
  // Required for CP-command methods; omitted for daemon-level explicit ops.
  cpId: z.string().max(256).optional(),
  method: z.string().max(128),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof rpcRequestSchema>;

/** The ack payload. Generic `result` is refined per-method by `methods.ts`. */
export const rpcAckSchema = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: rpcErrorSchema }),
]);
export type RpcAck<R = unknown> =
  { ok: true; result: R } | { ok: false; error: RpcError };
