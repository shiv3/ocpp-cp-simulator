// Tier-3 schema-valid acks for CSMS core-control CALLs; real effects —
// availability application, reservation state, reset/unlock side effects —
// are deferred to a later fidelity phase.
import type {
  CancelReservationResponseV201,
  ChangeAvailabilityResponseV201,
  ClearCacheResponseV201,
  ReserveNowResponseV201,
  ResetResponseV201,
  TriggerMessageRequestV201,
  TriggerMessageResponseV201,
  UnlockConnectorResponseV201,
} from "../../../../ocpp";
import type {
  V201HandlerResult,
  V201InboundContext,
} from "./inboundRegistryV201";

export const handleResetV201 = (): V201HandlerResult => ({
  response: { status: "Accepted" } satisfies ResetResponseV201,
});

export const handleChangeAvailabilityV201 = (): V201HandlerResult => ({
  response: { status: "Accepted" } satisfies ChangeAvailabilityResponseV201,
});

export const handleUnlockConnectorV201 = (): V201HandlerResult => ({
  response: { status: "Unlocked" } satisfies UnlockConnectorResponseV201,
});

export const handleTriggerMessageV201 = (
  payload?: unknown,
  ctx?: V201InboundContext,
): V201HandlerResult => {
  const accepted = {
    status: "Accepted",
  } satisfies TriggerMessageResponseV201;

  if (payload === undefined || ctx === undefined) {
    return { response: accepted };
  }

  const req = payload as TriggerMessageRequestV201;
  const connectorId = req.evse?.id;

  switch (req.requestedMessage) {
    case "BootNotification":
      return {
        response: accepted,
        afterResult: () => ctx.chargePoint.boot(),
      };

    case "Heartbeat":
      return {
        response: accepted,
        afterResult: () => ctx.chargePoint.sendHeartbeat(),
      };

    case "StatusNotification":
      return {
        response: accepted,
        afterResult: () =>
          ctx.chargePoint.sendCurrentStatusNotification(connectorId),
      };

    case "MeterValues":
      return {
        response: accepted,
        afterResult: () => {
          if (connectorId === undefined || connectorId === 0) {
            for (const id of ctx.chargePoint.connectors.keys()) {
              ctx.chargePoint.sendMeterValue(id);
            }
            return;
          }
          ctx.chargePoint.sendMeterValue(connectorId);
        },
      };

    default:
      return {
        response: {
          status: "NotImplemented",
        } satisfies TriggerMessageResponseV201,
      };
  }
};

export const handleClearCacheV201 = (): V201HandlerResult => ({
  response: { status: "Accepted" } satisfies ClearCacheResponseV201,
});

export const handleReserveNowV201 = (): V201HandlerResult => ({
  response: { status: "Accepted" } satisfies ReserveNowResponseV201,
});

export const handleCancelReservationV201 = (): V201HandlerResult => ({
  response: { status: "Accepted" } satisfies CancelReservationResponseV201,
});
