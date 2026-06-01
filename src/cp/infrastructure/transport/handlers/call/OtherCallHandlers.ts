import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import * as request from "@voltbras/ts-ocpp/dist/messages/json/request";
import * as response from "@voltbras/ts-ocpp/dist/messages/json/response";
import { LogType } from "../../../../shared/Logger";

export class ChangeConfigurationHandler
  implements
    CallHandler<
      request.ChangeConfigurationRequest,
      response.ChangeConfigurationResponse
    >
{
  handle(
    payload: request.ChangeConfigurationRequest,
    context: HandlerContext,
  ): response.ChangeConfigurationResponse {
    const status = context.chargePoint.configuration.applyChange(
      payload.key,
      payload.value,
    );
    context.logger.info(
      `ChangeConfiguration ${payload.key}='${payload.value}' → ${status}`,
      LogType.CONFIGURATION,
    );
    return { status };
  }
}

export class TriggerMessageHandler
  implements
    CallHandler<request.TriggerMessageRequest, response.TriggerMessageResponse>
{
  handle(
    payload: request.TriggerMessageRequest,
    context: HandlerContext,
  ): response.TriggerMessageResponse {
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
  implements
    CallHandler<request.ClearCacheRequest, response.ClearCacheResponse>
{
  handle(
    payload: request.ClearCacheRequest,
    context: HandlerContext,
  ): response.ClearCacheResponse {
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
  implements
    CallHandler<
      request.UnlockConnectorRequest,
      response.UnlockConnectorResponse
    >
{
  handle(
    payload: request.UnlockConnectorRequest,
    context: HandlerContext,
  ): response.UnlockConnectorResponse {
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
