import type { V201Action } from "./inboundRegistryV201";

/** Actions the 2.x handler queues offline and replays (#528, E11; #538,
 *  N07.FR.04; #552, A04.FR.02). Any other row in `pending_messages` was queued by the 1.6
 *  handler under the same charge point id: the queue deletes it on load. */
export type V201QueuedAction = Extract<
  V201Action,
  "TransactionEvent" | "NotifyEvent" | "SecurityEventNotification"
>;
export const QUEUED_ON_OCPP2: ReadonlySet<V201QueuedAction> = new Set([
  "TransactionEvent",
  "NotifyEvent",
  "SecurityEventNotification",
]);
