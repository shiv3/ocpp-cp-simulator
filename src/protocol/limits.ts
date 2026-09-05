// Size and rate limits for the socket.io control-plane protocol (Sec-4 DoS
// hardening). These are the single source of truth shared by the zod method
// schemas (`methods.ts`), the server socket wiring (`socketServer.ts`), and the
// browser/CLI clients. Values are deliberately generous for legitimate use yet
// bounded so a malicious or buggy peer cannot exhaust the daemon.

import { z } from "zod";

/**
 * Max length of an `STR_64K` field.
 *
 * Exported as a number for the same reason as {@link ARRAY_MAX_ITEMS}: a
 * producer has to be able to clamp a string *before* it builds an envelope,
 * because a field that fails validation takes the whole event with it and the
 * push is merely logged (#314). One constant, so the clamp and the schema
 * cannot drift.
 */
export const STR_64K_MAX = 65_536;

/** General-purpose string field: ≤ 64 KB. */
export const STR_64K = z.string().max(STR_64K_MAX);

/**
 * Identifier-sized string: ≤ 256 chars, the same cap the rpc envelope already
 * enforces on `cpId`. For names and ids that end up in log lines, table keys
 * and metric labels, where 64 KB is not a bound anyone wants.
 */
export const STR_256 = z.string().max(256);

/** Short prose or a path: ≤ 1 KB. */
export const STR_1K = z.string().max(1_024);

/**
 * Max length of a `SCENARIO_STR_256K` field — in particular the `scenarioId`
 * the `file-reload` envelope carries.
 *
 * Exported as a number for the same reason as {@link STR_64K_MAX}: the value
 * has to be enforceable at the point a scenario is *loaded*, not only where an
 * event is validated. A definition arriving through `load_scenario { scenario }`
 * is bounded as a whole object by {@link SCENARIO_MAX_BYTES}, so its id cannot
 * exceed this — but a definition read from a **file** bypasses that object
 * schema entirely, so an id past this length loaded fine and then made every
 * reload event for it fail validation and be swallowed (#314). One constant, so
 * the loader's gate and the envelope cannot disagree.
 */
export const SCENARIO_ID_MAX = 262_144;

/** Scenario-definition payload string: ≤ 256 KB (scenarios can be large). */
export const SCENARIO_STR_256K = z.string().max(SCENARIO_ID_MAX);

/**
 * Max items in an `ARRAY_1000` field.
 *
 * Exported as a number, not just baked into the helper, because producers have
 * to be able to check the bound *before* they build a payload: the file-reload
 * path refuses an edit whose resulting `scenario-definitions-changed` snapshot
 * would not fit rather than applying it and failing validation on the way out
 * (#314). One constant, so the producer and the schema cannot drift apart.
 */
export const ARRAY_MAX_ITEMS = 1_000;

/** Array field capped at {@link ARRAY_MAX_ITEMS} items. */
export const ARRAY_1000 = <T extends z.ZodTypeAny>(schema: T) =>
  z.array(schema).max(ARRAY_MAX_ITEMS);

/**
 * Max charge points a single `cp.create_many` call may create.
 *
 * Bulk creation is the one control-plane method that allocates unbounded
 * resources from a single request — every created CP holds a WebSocket, a
 * message queue and (with `--state-db`) rows — so the ceiling is enforced in
 * the schema rather than left to the caller's good manners. 200 is well past
 * what a CI fleet asks for and well short of what exhausts a daemon; raise it
 * once `cp.create_many` has a measured per-process ceiling to sit under.
 */
export const CP_CREATE_MANY_MAX = 200;

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
