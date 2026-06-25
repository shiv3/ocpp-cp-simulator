// Tier-3 schema-valid acks for CSMS core-control CALLs. Availability has
// protocol-visible effects here; reservation state, reset/unlock side effects
// are deferred to a later fidelity phase.
import type {
  CancelReservationResponseV201,
  ChangeAvailabilityRequestV201,
  ChangeAvailabilityResponseV201,
  ClearCacheResponseV201,
  ReserveNowResponseV201,
  ResetRequestV201,
  ResetResponseV201,
  TriggerMessageRequestV201,
  TriggerMessageResponseV201,
  UnlockConnectorRequestV201,
  UnlockConnectorResponseV201,
} from "../../../../ocpp";
import type {
  V201HandlerResult,
  V201InboundContext,
} from "./inboundRegistryV201";
import { OCPPAvailability, OCPPStatus } from "../../../domain/types/OcppTypes";

export const handleResetV201 = (
  payload?: unknown,
  ctx?: V201InboundContext,
): V201HandlerResult => {
  if (payload === undefined || ctx === undefined) {
    return {
      response: { status: "Accepted" } satisfies ResetResponseV201,
    };
  }

  const req = payload as ResetRequestV201;
  const type: string = req.type;
  const { evseId } = req;
  const all = [...ctx.chargePoint.connectors.values()];
  const targets =
    evseId === undefined
      ? all
      : all.filter((connector) => connector.id === evseId);

  if (evseId !== undefined && targets.length === 0) {
    return {
      response: { status: "Rejected" } satisfies ResetResponseV201,
    };
  }

  if (type === "OnIdle" && targets.some((connector) => connector.transaction)) {
    return {
      response: { status: "Scheduled" } satisfies ResetResponseV201,
    };
  }

  return {
    response: { status: "Accepted" } satisfies ResetResponseV201,
    afterResult: () => {
      if (type !== "ImmediateAndResume") {
        for (const connector of targets) {
          if (connector.transaction) {
            ctx.chargePoint.stopTransaction(connector.id, "HardReset");
          }
        }
      }
      ctx.chargePoint.boot();
    },
  };
};

function availabilityStatus(target: OCPPAvailability): OCPPStatus {
  return target === "Operative" ? OCPPStatus.Available : OCPPStatus.Unavailable;
}

export const handleChangeAvailabilityV201 = (
  payload?: unknown,
  ctx?: V201InboundContext,
): V201HandlerResult => {
  if (payload === undefined || ctx === undefined) {
    return {
      response: { status: "Accepted" } satisfies ChangeAvailabilityResponseV201,
    };
  }

  const req = payload as ChangeAvailabilityRequestV201;
  const target: OCPPAvailability = req.operationalStatus;
  const connectorId = req.evse?.id;
  const nextStatus = availabilityStatus(target);

  if (connectorId === undefined) {
    const activeConnectors = Array.from(
      ctx.chargePoint.connectors.values(),
    ).filter((connector) => connector.transaction);
    if (activeConnectors.length > 0) {
      return {
        response: {
          status: "Scheduled",
        } satisfies ChangeAvailabilityResponseV201,
        afterResult: () => {
          for (const connector of activeConnectors) {
            connector.scheduledAvailability = target;
          }
        },
      };
    }

    return {
      response: {
        status: "Accepted",
      } satisfies ChangeAvailabilityResponseV201,
      afterResult: () => {
        ctx.chargePoint.updateConnectorStatus(0, nextStatus);
        for (const connector of ctx.chargePoint.connectors.values()) {
          connector.availability = target;
          ctx.chargePoint.updateConnectorStatus(connector.id, nextStatus);
        }
        ctx.chargePoint.persistAvailability();
      },
    };
  }

  const connector = ctx.chargePoint.getConnector(connectorId);
  if (!connector) {
    return {
      response: {
        status: "Rejected",
      } satisfies ChangeAvailabilityResponseV201,
    };
  }

  if (connector.transaction) {
    return {
      response: {
        status: "Scheduled",
      } satisfies ChangeAvailabilityResponseV201,
      afterResult: () => {
        connector.scheduledAvailability = target;
      },
    };
  }

  return {
    response: {
      status: "Accepted",
    } satisfies ChangeAvailabilityResponseV201,
    afterResult: () => {
      connector.availability = target;
      ctx.chargePoint.updateConnectorStatus(connectorId, nextStatus);
      ctx.chargePoint.persistAvailability();
    },
  };
};

export function handleUnlockConnectorV201(): V201HandlerResult;
export function handleUnlockConnectorV201(
  payload: unknown,
  ctx: V201InboundContext,
): V201HandlerResult;
export function handleUnlockConnectorV201(
  payload?: unknown,
  ctx?: V201InboundContext,
): V201HandlerResult {
  if (payload === undefined || ctx === undefined) {
    return {
      response: { status: "Unlocked" } satisfies UnlockConnectorResponseV201,
    };
  }

  const req = payload as UnlockConnectorRequestV201;
  const connector = ctx.chargePoint.getConnector(req.evseId);
  if (!connector) {
    return {
      response: {
        status: "UnknownConnector",
      } satisfies UnlockConnectorResponseV201,
    };
  }

  if (connector.transaction) {
    // OCPP 2.0.1: do not unlock or stop an ongoing authorized transaction.
    return {
      response: {
        status: "OngoingAuthorizedTransaction",
      } satisfies UnlockConnectorResponseV201,
    };
  }

  return {
    response: { status: "Unlocked" } satisfies UnlockConnectorResponseV201,
  };
}

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
