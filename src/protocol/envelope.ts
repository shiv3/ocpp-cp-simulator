// The socket.io wire envelopes:
//   * `rpc` request/ack  (re-exported from errors.ts)
//   * `event` push       (tagged union: kind "cp" | "registry" | "config" |
//                         "scenario-definitions" | "file-reload")
//   * the subscribe-ack snapshot returned atomically by `events.subscribe`
//
// The `event` union exists only at the socket emit boundary; the server-side
// EventBus envelope (`{cpId, evt}`) is unchanged.

import { z } from "zod";

import {
  ARRAY_1000,
  SCENARIO_MAX_BYTES,
  SCENARIO_STR_256K,
  STR_64K,
  boundedObject,
} from "./limits";
import {
  cliEventWireSchema,
  cpListItemSchema,
  statusWireSchema,
  wireSimulatorConfigSchema,
} from "./events";

export {
  rpcRequestSchema,
  rpcAckSchema,
  rpcErrorSchema,
  RPC_ERROR_CODES,
} from "./errors";
export type { RpcRequest, RpcAck, RpcError, RpcErrorCode } from "./errors";

const scenarioDefinitionsChangedEnvelopeSchema = z.object({
  kind: z.literal("scenario-definitions"),
  event: z.literal("scenario-definitions-changed"),
  cpId: STR_64K,
  connectorId: z.number().int().min(1).nullable(),
  definitions: ARRAY_1000(boundedObject(SCENARIO_MAX_BYTES)),
});

/**
 * A file the daemon loaded changed on disk and `--watch` re-read it (#314).
 *
 * Pushed so a console or an agent sees the edit rather than inferring it from
 * behaviour. `outcome` is the whole contract: `applied` means the new copy is
 * live, `deferred` means it parsed but the charge point is mid-session and it
 * will be installed when that session ends, and `rejected` means the file did
 * not parse and the previous good copy is untouched.
 */
const fileReloadEnvelopeSchema = z.object({
  kind: z.literal("file-reload"),
  event: z.literal("file-reloaded"),
  target: z.enum(["id-tags", "scenario"]),
  // Bounded to match the input side, not tighter. `load_scenario`'s `file` and
  // `run_scenario_file`'s `file` are `STR_64K`, and a path over 1024 characters
  // is legal under Linux's `PATH_MAX`, so a shorter bound here failed
  // validation on a reload that had already been applied: the envelope threw,
  // the manager caught it, and subscribers silently got no event for a change
  // that had happened. `--watch` now emits the *resolved absolute* path (#314),
  // which is longer than whatever the caller supplied, so the gap was wider
  // than the input contract alone suggests.
  path: STR_64K,
  cpId: STR_64K,
  connectorId: z.number().int().min(1).nullable(),
  // Bounded by the definition that carries it, not by the generic string cap:
  // a file-backed scenario gets only a minimal shape check, so an id past 64 KB
  // is accepted while the definition stays under its own size gate — and the
  // reload then applied while this envelope rejected it, swallowing the event.
  // `SCENARIO_MAX_BYTES` is the definition's cap, so an id inside a definition
  // that passed it always fits here.
  scenarioId: SCENARIO_STR_256K.nullable(),
  outcome: z.enum(["applied", "deferred", "rejected"]),
  // The rejection messages embed the path they are about
  // (`idTagPool.file "<path>" is not valid JSON`), so bounding this tighter
  // than `path` reintroduces exactly the same silent loss on the one outcome
  // an operator most needs to see.
  error: STR_64K.nullable(),
});

/** Server → client push. Distinguished by `kind`. */
export const eventEnvelopeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cp"),
    cpId: z.string().max(256),
    evt: cliEventWireSchema,
  }),
  z.object({
    kind: z.literal("registry"),
    change: z.enum(["added", "removed", "updated", "reset"]),
    cp: cpListItemSchema.optional(),
  }),
  z.object({
    kind: z.literal("config"),
    event: z.literal("config-changed"),
    config: wireSimulatorConfigSchema.nullable(),
  }),
  scenarioDefinitionsChangedEnvelopeSchema,
  fileReloadEnvelopeSchema,
]);
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/** Atomic `events.subscribe` ack: rooms joined + the current snapshot. */
export const subscribeResultSchema = z.object({
  subscribed: ARRAY_1000(z.string().max(256)),
  snapshot: z.object({
    cps: ARRAY_1000(cpListItemSchema),
    perCp: z.record(z.string(), statusWireSchema),
  }),
});
export type SubscribeResult = z.infer<typeof subscribeResultSchema>;
