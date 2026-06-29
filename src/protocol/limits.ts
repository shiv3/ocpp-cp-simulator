// Size and rate limits for the socket.io control-plane protocol (Sec-4 DoS
// hardening). These are the single source of truth shared by the zod method
// schemas (`methods.ts`), the server socket wiring (`socketServer.ts`), and the
// browser/CLI clients. Values are deliberately generous for legitimate use yet
// bounded so a malicious or buggy peer cannot exhaust the daemon.

import { z } from "zod";

/** General-purpose string field: ≤ 64 KB. */
export const STR_64K = z.string().max(65_536);

/** Scenario-definition payload string: ≤ 256 KB (scenarios can be large). */
export const SCENARIO_STR_256K = z.string().max(262_144);

/** Array field capped at 1000 items. */
export const ARRAY_1000 = <T extends z.ZodTypeAny>(schema: T) =>
  z.array(schema).max(1_000);

/** Client-side rpc ack timeout (ms). Also the server-side handler deadline. */
export const RPC_TIMEOUT_MS = 30_000;

/** socket.io / Engine.IO `maxHttpBufferSize` (bytes). */
export const MAX_HTTP_BUFFER = 1_000_000;

/** Max rooms a single socket may join. */
export const ROOM_CAP = 256;

/** Max in-flight rpc calls per socket. */
export const INFLIGHT_CAP = 64;

/** Sustained rpc rate budget per socket (calls/second). */
export const RPC_RATE_PER_SEC = 100;

/** Max serialized size (bytes) of a scenario-definition object param. */
export const SCENARIO_MAX_BYTES = 262_144;

/** Max serialized size (bytes) of a generic settings/config object param. */
export const OBJ_MAX_BYTES = 65_536;

/**
 * A free-form object param bounded by its serialized size — used for
 * settings/config/options/scenario params whose inner shape is owned by the
 * domain layer but must still be size-capped (Sec-4 DoS).
 */
export const boundedObject = (maxBytes: number) =>
  z
    .record(z.string(), z.unknown())
    .refine((o) => JSON.stringify(o).length <= maxBytes, {
      message: `object exceeds ${maxBytes} bytes`,
    });
