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
  UnlockConnectorResponseV201,
} from "@ocpp-cp-simulator/ocpp/index";
import type {
  V201HandlerResult,
  V201InboundContext,
} from "./inboundRegistryV201";
import { LogType } from "../../../shared/Logger";
import { OCPP_2_1 } from "../../../domain/types/OcppVersion";

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

/**
 * F05 UnlockConnector.req: translation only. The `default.unlock` behavior of
 * the charger engine decides (`application/engine/behaviors/unlock.ts`).
 */
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
  const { response } = ctx.chargePoint.engine.runDefault(
    "UnlockConnector",
    payload,
  );
  return { response };
}

/** L01.FR.25 / L01.FR.26 (and L02.FR.16 / FR.17): a TriggerMessage for
 *  FirmwareStatusNotification answers the last sent status, except `Installed`
 *  which is answered with `Idle`; with nothing sent yet (F06.FR.16) it is
 *  `Idle`. A report with a requestId is mandatory unless the message was
 *  triggered AND no update is ongoing, which is what `Idle` says. */
const FIRMWARE_ENDED_AS_IDLE: ReadonlySet<string> = new Set([
  "Installed",
  "Idle",
]);

/** UploadLogStatusEnumType values of an upload that has not ended (F06.FR.14;
 *  F06.FR.15: not uploading is `Idle`, which N01.FR.13 lets go without a
 *  requestId when triggered). */
const LOG_IN_PROGRESS: ReadonlySet<string> = new Set(["Uploading"]);

/** The `chargingState` a triggered TransactionEvent reports for a connector
 *  status; any other status of a running transaction is `EVConnected`. */
const TRIGGER_CHARGING_STATE: Record<
  string,
  "Charging" | "SuspendedEV" | "SuspendedEVSE"
> = {
  Charging: "Charging",
  SuspendedEV: "SuspendedEV",
  SuspendedEVSE: "SuspendedEVSE",
};

function reportTriggeredStatus(
  status: string,
  requestId: number | null,
  idle: { has(status: string): boolean },
  send: (status: string, requestId?: number) => void,
  idleWhenIn = true,
): void {
  if (idle.has(status) === idleWhenIn) {
    send("Idle");
  } else {
    send(status, requestId ?? undefined);
  }
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

  // #553, 2.1 F06.FR.08. 2.0.1 has no V2G20 certificate (its schema refuses
  // SignV2G20Certificate before this runs) and keeps answering
  // NotImplemented for SignCombinedCertificate.
  const requested: string = req.requestedMessage;
  // #618: a target the capability profile leaves out is not implemented.
  if (ctx.chargePoint?.isTriggerTargetSupported?.(requested) === false) {
    return notImplemented;
  }
  if (
    requested === "SignV2G20Certificate" ||
    requested === "SignCombinedCertificate"
  ) {
    const signing = ctx.certificateSigning;
    if (!signing || ctx.chargePoint.ocppVersion !== OCPP_2_1) {
      return notImplemented;
    }
    return {
      response: accepted,
      afterResult: () => {
        const sent =
          requested === "SignV2G20Certificate"
            ? signing.requestSignature("V2G20Certificate")
            : signing.requestCombinedSignature();
        sent.catch((err: unknown) => {
          ctx.logger.error(
            `TriggerMessage ${requested}: could not send SignCertificate: ${err instanceof Error ? err.message : String(err)}`,
            LogType.OCPP,
          );
        });
      },
    };
  }

  switch (req.requestedMessage) {
    case "BootNotification":
      // F06.FR.17: after an Accepted boot the answer is Rejected and nothing
      // is sent. Pending, Rejected and unanswered boots keep Accepted.
      if (ctx.bootAccepted?.()) {
        return {
          response: { status: "Rejected" } satisfies TriggerMessageResponseV201,
        };
      }
      return {
        response: accepted,
        afterResult: () => ctx.chargePoint.boot("Triggered"),
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
          // F06.FR.06: the measurands of AlignedDataCtrlr.Measurands, with
          // context Trigger (ReadingContextEnumType). An empty aligned list
          // falls back to the sampled list: TC_F_11_CS/TC_F_12_CS expect a
          // MeterValuesRequest from a station that configured neither.
          const aligned =
            ctx.chargePoint.configuration.meterValuesAlignedData();
          const measurands =
            aligned.length > 0
              ? aligned
              : ctx.chargePoint.configuration.meterValuesSampledData();
          const send = (id: number): void =>
            ctx.chargePoint.sendMeterValue(id, "Trigger", { measurands });
          if (connectorId === undefined || connectorId === 0) {
            for (const id of ctx.chargePoint.connectors.keys()) send(id);
            // The station main meter on connector 0 / EVSE 0 (#617), when it has one.
            if (ctx.chargePoint.mainMeter) send(0);
            return;
          }
          send(connectorId);
        },
      };

    // #596 F06: an Updated event with triggerReason Trigger for the running
    // transaction of the requested EVSE, or of every EVSE without one. With
    // no running transaction there is nothing to report: Rejected.
    case "TransactionEvent": {
      const targets = Array.from(ctx.chargePoint.connectors.values())
        .filter(
          (c) =>
            c.hasRunningTransaction &&
            (connectorId === undefined ||
              connectorId === 0 ||
              c.id === connectorId),
        )
        .map((c) => ({ id: c.id, status: String(c.status) }));
      if (targets.length === 0) {
        return {
          response: {
            status: "Rejected",
            statusInfo: {
              reasonCode: "TxNotFound",
              additionalInfo: "No transaction is running on the requested EVSE",
            },
          } satisfies TriggerMessageResponseV201,
        };
      }
      return {
        response: accepted,
        afterResult: () => {
          // F06.FR.07: triggerReason Trigger, transactionInfo with at least
          // the chargingState, and the most recent meter sample.
          for (const { id, status } of targets) {
            ctx.chargePoint.sendTransactionUpdate(id, {
              triggerReason: "Trigger",
              chargingState: TRIGGER_CHARGING_STATE[status] ?? "EVConnected",
              meterValues: true,
              context: "Trigger",
            });
          }
        },
      };
    }

    // #596 L01.FR.25/26, F06.FR.14-16: the last status the station sent for
    // the update / the upload (the engine holds it however it was sent), Idle
    // when none, after `Installed` or, for a log, when not uploading. Idle
    // carries no requestId.
    case "FirmwareStatusNotification": {
      const { status, requestId } = ctx.chargePoint.engine.state.firmware;
      return {
        response: accepted,
        afterResult: () =>
          reportTriggeredStatus(
            status,
            requestId,
            FIRMWARE_ENDED_AS_IDLE,
            (s, id) =>
              ctx.chargePoint.sendFirmwareStatusNotification(s as never, id),
          ),
      };
    }

    case "LogStatusNotification": {
      const { status, requestId } = ctx.chargePoint.engine.state.log;
      return {
        response: accepted,
        afterResult: () =>
          reportTriggeredStatus(
            status,
            requestId,
            LOG_IN_PROGRESS,
            (s, id) =>
              ctx.chargePoint.sendLogStatusNotification(s as never, id),
            false,
          ),
      };
    }

    // #537 A02: a new key pair and CSR once the answer is written
    // (A02.FR.02, F06.FR.04). SignV2G20Certificate and SignCombinedCertificate
    // (2.1, F06.FR.08) are handled before the switch.
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
