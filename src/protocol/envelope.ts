// The socket.io wire envelopes:
//   * `rpc` request/ack  (re-exported from errors.ts)
//   * `event` push       (tagged union: kind "cp" | "registry")
//   * the subscribe-ack snapshot returned atomically by `events.subscribe`
//
// The `event` union exists only at the socket emit boundary; the server-side
// EventBus envelope (`{cpId, evt}`) is unchanged.

import { z } from "zod";

import {
  ARRAY_1000,
  SCENARIO_MAX_BYTES,
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
