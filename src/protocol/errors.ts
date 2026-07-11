// Closed error-code union + the rpc request/ack envelope schemas for the
// socket.io control plane. The error union is intentionally small and closed so
// both server and client agree on every failure mode; `timeout`/`disconnected`
// are client-synthesised when an ack never arrives (see the rpc wrapper).

import { z } from "zod";

export const RPC_ERROR_CODES = [
  "not_found",
  "invalid_params",
  "internal",
  "unauthorized",
  "timeout",
  "disconnected",
] as const;

export const rpcErrorCodeSchema = z.enum(RPC_ERROR_CODES);
export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number];

export const rpcErrorSchema = z.object({
  code: rpcErrorCodeSchema,
  // Human-readable; MUST NOT contain credentials (Sec-2 / non-leakage).
  message: z.string().max(2_000),
});
export type RpcError = z.infer<typeof rpcErrorSchema>;

/** Thrown by the client rpc wrapper; carries a typed `code`. */
export class RpcFailure extends Error {
  readonly code: RpcErrorCode;
  constructor(code: RpcErrorCode, message: string) {
    super(message);
    this.name = "RpcFailure";
    this.code = code;
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
