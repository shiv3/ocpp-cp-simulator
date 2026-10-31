// Tier-3 schema-valid acks for CSMS core-control CALLs. Availability and
// reservations have protocol-visible effects here; reset/unlock side effects
// are deferred to a later fidelity phase.
import type {
  CancelReservationRequestV201,
  CancelReservationResponseV201,
  ChangeAvailabilityRequestV201,
  ChangeAvailabilityResponseV201,
  ClearCacheResponseV201,
  ReserveNowRequestV201,
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
import {
  OCPPAvailability,
  OCPPStatus,
  ReservationStatus,
} from "../../../domain/types/OcppTypes";
import { LogType } from "../../../shared/Logger";

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
            ctx.chargePoint.stopTransaction(connector.id, "HardReset", {
              triggerReason: "ResetCommand",
            });
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
    response: {
      status:
        connector.unlockResponse === "Unlocked" ? "Unlocked" : "UnlockFailed",
    } satisfies UnlockConnectorResponseV201,
  };
}

export const handleTriggerMessageV201 = (
  payload?: unknown,
  ctx?: V201InboundContext,
): V201HandlerResult => {
  const accepted = {
    status: "Accepted",
  } satisfies TriggerMessageResponseV201;
  const notImplemented = {
    response: { status: "NotImplemented" } satisfies TriggerMessageResponseV201,
  };

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

    // #537 A02: a new key pair and CSR once the answer is written
    // (A02.FR.02, F06.FR.04). SignCombinedCertificate and 2.1's
    // SignV2G20Certificate stay NotImplemented (F06.FR.08).
    case "SignChargingStationCertificate":
    case "SignV2GCertificate": {
      const signing = ctx.certificateSigning;
      if (!signing) return notImplemented;
      const use =
        req.requestedMessage === "SignV2GCertificate"
          ? "V2GCertificate"
          : "ChargingStationCertificate";
      return {
        response: accepted,
        afterResult: () => {
          signing.requestSignature(use).catch((err: unknown) => {
            ctx.logger.error(
              `TriggerMessage ${req.requestedMessage}: could not send SignCertificate: ${err instanceof Error ? err.message : String(err)}`,
              LogType.OCPP,
            );
          });
        },
      };
    }

    default:
      return notImplemented;
  }
};

/**
 * ClearCache (#452, 2.0.1 / 2.1 Part 2 C11). While `AuthCacheCtrlr.Enabled`
 * is false the answer is Rejected (C11.FR.04) and the content is kept: the
 * AuthCacheEnabled note says switching the cache off does not alter it, and
 * the status reports whether it was cleared (C11.FR.02). Enabled, the cache
 * is cleared: Accepted (C11.FR.03), or Rejected if that failed (C11.FR.05).
 * 1.6 differs on purpose: see `ClearCacheHandler`.
 */
export const handleClearCacheV201 = (
  _payload: unknown,
  ctx: V201InboundContext,
): V201HandlerResult => {
  const cp = ctx.chargePoint;
  const status: ClearCacheResponseV201["status"] =
    cp.configuration.authorizationCacheEnabled() && cp.clearAuthorizationCache()
      ? "Accepted"
      : "Rejected";
  return { response: { status } satisfies ClearCacheResponseV201 };
};

export const handleReserveNowV201 = (
  payload?: unknown,
  ctx?: V201InboundContext,
): V201HandlerResult => {
  if (payload === undefined || ctx === undefined) {
    return {
      response: { status: "Accepted" } satisfies ReserveNowResponseV201,
    };
  }

  const req = payload as ReserveNowRequestV201;
  const connectorId = req.evseId ?? 1;
  const connector = ctx.chargePoint.getConnector(connectorId);

  if (!connector) {
    return {
      response: { status: "Rejected" } satisfies ReserveNowResponseV201,
    };
  }

  if (connector.status === OCPPStatus.Faulted) {
    return {
      response: { status: "Faulted" } satisfies ReserveNowResponseV201,
    };
  }

  if (connector.status === OCPPStatus.Charging || connector.transaction) {
    return {
      response: { status: "Occupied" } satisfies ReserveNowResponseV201,
    };
  }

  if (connector.availability !== "Operative") {
    return {
      response: { status: "Unavailable" } satisfies ReserveNowResponseV201,
    };
  }

  const status = ctx.chargePoint.reservationManager.createReservation(
    connectorId,
    new Date(req.expiryDateTime),
    req.idToken.idToken,
    req.groupIdToken?.idToken,
    req.id,
  );

  return {
    response: {
      status: status as ReserveNowResponseV201["status"],
    } satisfies ReserveNowResponseV201,
    afterResult:
      status === ReservationStatus.Accepted
        ? () =>
            ctx.chargePoint.updateConnectorStatus(
              connectorId,
              OCPPStatus.Reserved,
            )
        : undefined,
  };
};

export const handleCancelReservationV201 = (
  payload?: unknown,
  ctx?: V201InboundContext,
): V201HandlerResult => {
  if (payload === undefined || ctx === undefined) {
    return {
      response: { status: "Accepted" } satisfies CancelReservationResponseV201,
    };
  }

  const req = payload as CancelReservationRequestV201;
  const mgr = ctx.chargePoint.reservationManager;
  const reservation = mgr.getReservation(req.reservationId);
  const cancelled = mgr.cancelReservation(req.reservationId);

  if (cancelled && reservation) {
    return {
      response: { status: "Accepted" } satisfies CancelReservationResponseV201,
      afterResult: () => {
        const connector = ctx.chargePoint.getConnector(reservation.connectorId);
        if (connector && connector.status === OCPPStatus.Reserved) {
          ctx.chargePoint.updateConnectorStatus(
            reservation.connectorId,
            OCPPStatus.Available,
          );
        }
      },
    };
  }

  return {
    response: { status: "Rejected" } satisfies CancelReservationResponseV201,
  };
};
