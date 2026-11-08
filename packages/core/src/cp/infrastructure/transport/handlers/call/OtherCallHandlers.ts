import type { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import type {
  ChangeConfigurationRequestV16,
  ChangeConfigurationResponseV16,
  ClearCacheRequestV16,
  ClearCacheResponseV16,
  TriggerMessageRequestV16,
  TriggerMessageResponseV16,
  UnlockConnectorRequestV16,
  UnlockConnectorResponseV16,
} from "@ocpp-cp-sim/ocpp/index";
import type { HandlerOutcome } from "../../network-sim/ResponseEffectQueue";
import { REDACTED_VALUE } from "../../../../shared/redaction";
import { LogType } from "../../../../shared/Logger";
import { defaultBehavior16 } from "./defaultBehavior";
import {
  diagnosticsTriggerStatus,
  firmwareTriggerStatus,
} from "./triggerStatus";
import type {
  DiagnosticsStatus,
  FirmwareStatus,
} from "../../../../domain/types/FirmwareLogStatus";

export class ChangeConfigurationHandler implements CallHandler<
  ChangeConfigurationRequestV16,
  ChangeConfigurationResponseV16
> {
  handle(
    payload: ChangeConfigurationRequestV16,
    context: HandlerContext,
  ): ChangeConfigurationResponseV16 {
    const status = context.chargePoint.configuration.applyChange(
      payload.key,
      payload.value,
    );
    const loggedValue = context.chargePoint.configuration.isWriteOnly(
      payload.key,
    )
      ? REDACTED_VALUE
      : payload.value;
    context.logger.info(
      `ChangeConfiguration ${payload.key}='${loggedValue}' → ${status}`,
      LogType.CONFIGURATION,
    );
    return { status };
  }
}

export class TriggerMessageHandler implements CallHandler<
  TriggerMessageRequestV16,
  TriggerMessageResponseV16
> {
  handle(
    payload: TriggerMessageRequestV16,
    context: HandlerContext,
  ): TriggerMessageResponseV16 | HandlerOutcome {
    context.logger.info(
      `Trigger message request received: ${payload.requestedMessage}` +
        (payload.connectorId !== undefined
          ? ` (connectorId=${payload.connectorId})`
          : ""),
      LogType.OCPP,
    );

    // OCPP 1.6J §6.51: the response is sent first (Accepted/Rejected), then
    // the CP fires the requested message after answering. The effect is
    // deferred via HandlerOutcome so the CALLRESULT goes out before the new CALL.
    switch (payload.requestedMessage) {
      case "StatusNotification": {
        const response = { status: "Accepted" } as const;
        const outcome: HandlerOutcome = {
          kind: "handler-outcome",
          payload: response,
          afterResponseSettled: () =>
            context.chargePoint.sendCurrentStatusNotification(
              payload.connectorId,
            ),
        };
        return outcome;
      }

      case "Heartbeat": {
        const response = { status: "Accepted" } as const;
        const outcome: HandlerOutcome = {
          kind: "handler-outcome",
          payload: response,
          afterResponseSettled: () => context.chargePoint.sendHeartbeat(),
        };
        return outcome;
      }

      case "MeterValues": {
        const targetConnectorId = payload.connectorId;
        const response = { status: "Accepted" } as const;
        const outcome: HandlerOutcome = {
          kind: "handler-outcome",
          payload: response,
          afterResponseSettled: () => {
            if (targetConnectorId === undefined || targetConnectorId === 0) {
              for (const id of context.chargePoint.connectors.keys()) {
                context.chargePoint.sendMeterValue(id);
              }
              return;
            }
            context.chargePoint.sendMeterValue(targetConnectorId);
          },
        };
        return outcome;
      }

      case "BootNotification": {
        // §5.17 + §4.2: re-send BootNotification. This is permitted even
        // while the boot gate is Pending/Rejected — TriggerMessage is one
        // of the few CSMS-driven escapes from those states.
        const response = { status: "Accepted" } as const;
        const outcome: HandlerOutcome = {
          kind: "handler-outcome",
          payload: response,
          afterResponseSettled: () => context.chargePoint.boot(),
        };
        return outcome;
      }

      case "DiagnosticsStatusNotification": {
        // §4.4: Idle only when not busy uploading diagnostics.
        const response = { status: "Accepted" } as const;
        const outcome: HandlerOutcome = {
          kind: "handler-outcome",
          payload: response,
          afterResponseSettled: () =>
            context.chargePoint.sendDiagnosticsStatusNotification(
              diagnosticsTriggerStatus(context.chargePoint.engine.state)
                .status as DiagnosticsStatus,
            ),
        };
        return outcome;
      }

      case "FirmwareStatusNotification": {
        // §4.5: Idle only when not downloading or installing.
        const response = { status: "Accepted" } as const;
        const outcome: HandlerOutcome = {
          kind: "handler-outcome",
          payload: response,
          afterResponseSettled: () =>
            context.chargePoint.sendFirmwareStatusNotification(
              firmwareTriggerStatus(context.chargePoint.engine.state)
                .status as FirmwareStatus,
            ),
        };
        return outcome;
      }

      default:
        return { status: "NotImplemented" };
    }
  }
}

export class ClearCacheHandler implements CallHandler<
  ClearCacheRequestV16,
  ClearCacheResponseV16
> {
  handle(
    payload: ClearCacheRequestV16,
    context: HandlerContext,
  ): ClearCacheResponseV16 {
    context.logger.info(
      `Clear cache request received: ${JSON.stringify(payload)}`,
      LogType.OCPP,
    );
    // #452, §5.4: clear the real Authorization Cache; the status says
    // whether that worked. The cache is implemented (§9.1.2: the
    // AuthorizationCacheEnabled key exists), so errata v4.0 §3.23's
    // "not implemented → Rejected" does not apply, and clearing a disabled
    // cache succeeds as well.
    const cleared = context.chargePoint.clearAuthorizationCache();
    return { status: cleared ? "Accepted" : "Rejected" };
  }
}

/**
 * §5.18 UnlockConnector.req: translation only. The charger engine's
 * `default.unlock` behavior stops a transaction in flight (reason
 * `UnlockCommand`, §7.36) and returns the connector's configured unlock
 * response (`application/engine/behaviors/unlock.ts`).
 */
export class UnlockConnectorHandler implements CallHandler<
  UnlockConnectorRequestV16,
  UnlockConnectorResponseV16
> {
  handle(
    payload: UnlockConnectorRequestV16,
    context: HandlerContext,
  ): UnlockConnectorResponseV16 {
    return defaultBehavior16(
      context.chargePoint,
      "UnlockConnector",
      payload,
    ) as UnlockConnectorResponseV16;
  }
}
