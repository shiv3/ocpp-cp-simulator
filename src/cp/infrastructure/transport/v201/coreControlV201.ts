// Tier-3 schema-valid acks for CSMS core-control CALLs; real effects — availability application, reservation state, triggered messages, reset/unlock side effects — are deferred to a later fidelity phase.
import type {
  CancelReservationResponseV201,
  ChangeAvailabilityResponseV201,
  ClearCacheResponseV201,
  ReserveNowResponseV201,
  ResetResponseV201,
  TriggerMessageResponseV201,
  UnlockConnectorResponseV201,
} from "../../../../ocpp";
import type { V201HandlerResult } from "./inboundRegistryV201";

export const handleResetV201 = (): V201HandlerResult => ({
  response: { status: "Accepted" } satisfies ResetResponseV201,
});

export const handleChangeAvailabilityV201 = (): V201HandlerResult => ({
  response: { status: "Accepted" } satisfies ChangeAvailabilityResponseV201,
});

export const handleUnlockConnectorV201 = (): V201HandlerResult => ({
  response: { status: "Unlocked" } satisfies UnlockConnectorResponseV201,
});

export const handleTriggerMessageV201 = (): V201HandlerResult => ({
  response: { status: "Accepted" } satisfies TriggerMessageResponseV201,
});

export const handleClearCacheV201 = (): V201HandlerResult => ({
  response: { status: "Accepted" } satisfies ClearCacheResponseV201,
});

export const handleReserveNowV201 = (): V201HandlerResult => ({
  response: { status: "Accepted" } satisfies ReserveNowResponseV201,
});

export const handleCancelReservationV201 = (): V201HandlerResult => ({
  response: { status: "Accepted" } satisfies CancelReservationResponseV201,
});
