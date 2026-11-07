// Tier-3 schema-valid acks for CSMS core-control CALLs. Availability and
// reservations have protocol-visible effects here; reset/unlock side effects
// are deferred to a later fidelity phase.
import type {
  CancelReservationResponseV201,
  ChangeAvailabilityResponseV201,
  ClearCacheResponseV201,
  ReserveNowResponseV201,
  ResetResponseV201,
  TriggerMessageRequestV201,
  TriggerMessageResponseV201,
  UnlockConnectorRequestV201,
  UnlockConnectorResponseV201,
} from "@ocpp-cp-sim/ocpp/index";
import type {
  V201HandlerResult,
  V201InboundContext,
} from "./inboundRegistryV201";
import { LogType } from "../../../shared/Logger";

/**
 * B11 / B12 Reset.req: translation only. The `default.reset` behavior of the
 * charger engine answers and resets once the answer settled
 * (`application/engine/behaviors/reset.ts`).
 */
export const handleResetV201 = (
  payload?: unknown,
  ctx?: V201InboundContext,
): V201HandlerResult => {
  if (payload === undefined || ctx === undefined) {
    return {
      response: { status: "Accepted" } satisfies ResetResponseV201,
    };
  }
  const { response, effect } = ctx.chargePoint.engine.runDefault(
    "Reset",
    payload,
  );
  return { response, ...(effect ? { afterResult: effect } : {}) };
};

/**
 * G03 ChangeAvailability.req: translation only. The `default.availability`
 * behavior of the charger engine decides and applies the change once the
 * answer settled (`application/engine/behaviors/availability.ts`).
 */
export const handleChangeAvailabilityV201 = (
  payload?: unknown,
  ctx?: V201InboundContext,
): V201HandlerResult => {
  if (payload === undefined || ctx === undefined) {
    return {
      response: { status: "Accepted" } satisfies ChangeAvailabilityResponseV201,
    };
  }
  const { response, effect } = ctx.chargePoint.engine.runDefault(
    "ChangeAvailability",
    payload,
  );
  return { response, ...(effect ? { afterResult: effect } : {}) };
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

/**
 * H01 ReserveNow.req: translation only. The `default.reservation` behavior of
 * the charger engine decides and reserves the connector once the answer
 * settled (`application/engine/behaviors/reservation.ts`).
 */
export const handleReserveNowV201 = (
  payload?: unknown,
  ctx?: V201InboundContext,
): V201HandlerResult => {
  if (payload === undefined || ctx === undefined) {
    return {
      response: { status: "Accepted" } satisfies ReserveNowResponseV201,
    };
  }
  const { response, effect } = ctx.chargePoint.engine.runDefault(
    "ReserveNow",
    payload,
  );
  return { response, ...(effect ? { afterResult: effect } : {}) };
};

/** H02 CancelReservation.req: translation only, like {@link handleReserveNowV201}. */
export const handleCancelReservationV201 = (
  payload?: unknown,
  ctx?: V201InboundContext,
): V201HandlerResult => {
  if (payload === undefined || ctx === undefined) {
    return {
      response: { status: "Accepted" } satisfies CancelReservationResponseV201,
    };
  }
  const { response, effect } = ctx.chargePoint.engine.runDefault(
    "CancelReservation",
    payload,
  );
  return { response, ...(effect ? { afterResult: effect } : {}) };
};
