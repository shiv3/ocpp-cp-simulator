import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import type {
  ChangeConfigurationRequestV16,
  ChangeConfigurationResponseV16,
  ClearCacheRequestV16,
  ClearCacheResponseV16,
  TriggerMessageRequestV16,
  TriggerMessageResponseV16,
  UnlockConnectorRequestV16,
  UnlockConnectorResponseV16,
} from "../../../../../ocpp";
import { REDACTED_VALUE } from "../../../../shared/redaction";
import { LogType } from "../../../../shared/Logger";

export class ChangeConfigurationHandler
  implements
    CallHandler<ChangeConfigurationRequestV16, ChangeConfigurationResponseV16>
{
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

export class TriggerMessageHandler
  implements CallHandler<TriggerMessageRequestV16, TriggerMessageResponseV16>
{
  handle(
    payload: TriggerMessageRequestV16,
    context: HandlerContext,
  ): TriggerMessageResponseV16 {
    context.logger.info(
      `Trigger message request received: ${payload.requestedMessage}` +
        (payload.connectorId !== undefined
          ? ` (connectorId=${payload.connectorId})`
          : ""),
      LogType.OCPP,
    );

    // OCPP 1.6J §6.51: the response is sent first (Accepted/Rejected), then
    // the CP fires the requested message after answering. Schedule via
    // queueMicrotask so the CALLRESULT goes out before the new CALL.
    switch (payload.requestedMessage) {
      case "StatusNotification":
        queueMicrotask(() =>
          context.chargePoint.sendCurrentStatusNotification(
            payload.connectorId,
          ),
        );
        return { status: "Accepted" };

      case "Heartbeat":
        queueMicrotask(() => context.chargePoint.sendHeartbeat());
        return { status: "Accepted" };

      case "MeterValues": {
        const targetConnectorId = payload.connectorId;
        queueMicrotask(() => {
          if (targetConnectorId === undefined || targetConnectorId === 0) {
            for (const id of context.chargePoint.connectors.keys()) {
              context.chargePoint.sendMeterValue(id);
            }
            return;
          }
          context.chargePoint.sendMeterValue(targetConnectorId);
        });
        return { status: "Accepted" };
      }

      case "BootNotification":
        // §5.17 + §4.2: re-send BootNotification. This is permitted even
        // while the boot gate is Pending/Rejected — TriggerMessage is one
        // of the few CSMS-driven escapes from those states.
        queueMicrotask(() => context.chargePoint.boot());
        return { status: "Accepted" };

      case "DiagnosticsStatusNotification":
        // §4.4: when not busy uploading diagnostics, respond Idle.
        queueMicrotask(() =>
          context.chargePoint.sendDiagnosticsStatusNotification("Idle"),
        );
        return { status: "Accepted" };

      case "FirmwareStatusNotification":
        // §4.5: same shape as DiagnosticsStatus — Idle if not busy.
        queueMicrotask(() =>
          context.chargePoint.sendFirmwareStatusNotification("Idle"),
        );
        return { status: "Accepted" };

      default:
        return { status: "NotImplemented" };
    }
  }
}

export class ClearCacheHandler
  implements CallHandler<ClearCacheRequestV16, ClearCacheResponseV16>
{
  handle(
    payload: ClearCacheRequestV16,
    context: HandlerContext,
  ): ClearCacheResponseV16 {
    context.logger.info(
      `Clear cache request received: ${JSON.stringify(payload)}`,
      LogType.OCPP,
    );
    return { status: "Accepted" };
  }
}

/**
 * §5.18: if a transaction is running on the target connector, finish it
 * first (reason=UnlockCommand per §7.36), then return the connector's
 * configured unlock response. The default is `Unlocked`; scenarios can
 * flip this to `UnlockFailed` or `NotSupported` to verify CSMS error paths.
 */
export class UnlockConnectorHandler
  implements CallHandler<UnlockConnectorRequestV16, UnlockConnectorResponseV16>
{
  handle(
    payload: UnlockConnectorRequestV16,
    context: HandlerContext,
  ): UnlockConnectorResponseV16 {
    const { connectorId } = payload;
    const connector = context.chargePoint.getConnector(connectorId);
    if (!connector) {
      context.logger.warn(
        `UnlockConnector: unknown connectorId=${connectorId}`,
        LogType.OCPP,
      );
      // §7.46: NotSupported also covers the "unknown ConnectorId" case
      // (errata 3.87).
      return { status: "NotSupported" };
    }

    if (connector.transaction) {
      context.logger.info(
        `UnlockConnector: stopping in-flight transaction on connector ${connectorId}`,
        LogType.OCPP,
      );
      context.chargePoint.stopTransaction(connector, "UnlockCommand");
    }

    context.logger.info(
      `UnlockConnector connector=${connectorId} → ${connector.unlockResponse}`,
      LogType.OCPP,
    );
    return { status: connector.unlockResponse };
  }
}
