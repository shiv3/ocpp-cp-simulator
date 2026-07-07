import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import type {
  ExtendedTriggerMessageRequestV16,
  ExtendedTriggerMessageResponseV16,
} from "../../../../../ocpp";
import { LogType } from "../../../../shared/Logger";

/**
 * §2 ExtendedTriggerMessage.req (OCPP 1.6 Security Whitepaper): a superset
 * of TriggerMessage.req (see `OtherCallHandlers.TriggerMessageHandler`)
 * covering the three Security messages plus the original Core set. Same
 * §6.51-style contract — respond Accepted/NotImplemented first, then fire
 * the requested message via `queueMicrotask` so the CALLRESULT is on the
 * wire before the new CALL.
 */
export class ExtendedTriggerMessageHandler
  implements
    CallHandler<
      ExtendedTriggerMessageRequestV16,
      ExtendedTriggerMessageResponseV16
    >
{
  handle(
    payload: ExtendedTriggerMessageRequestV16,
    context: HandlerContext,
  ): ExtendedTriggerMessageResponseV16 {
    context.logger.info(
      `Extended trigger message request received: ${payload.requestedMessage}` +
        (payload.connectorId !== undefined
          ? ` (connectorId=${payload.connectorId})`
          : ""),
      LogType.OCPP,
    );

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
        // §5.17 + §4.2: permitted even while the boot gate is
        // Pending/Rejected — same escape hatch as plain TriggerMessage.
        queueMicrotask(() => context.chargePoint.boot());
        return { status: "Accepted" };

      case "SignChargePointCertificate":
        queueMicrotask(() => {
          context.chargePoint.sendSignCertificate().catch((err) => {
            context.logger.warn(
              `SignChargePointCertificate trigger failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
              LogType.OCPP,
            );
          });
        });
        return { status: "Accepted" };

      case "LogStatusNotification":
        // Not currently uploading a log — Idle, mirroring the
        // DiagnosticsStatusNotification trigger contract.
        queueMicrotask(() =>
          context.chargePoint.sendLogStatusNotification("Idle"),
        );
        return { status: "Accepted" };

      case "FirmwareStatusNotification":
        queueMicrotask(() =>
          context.chargePoint.sendSignedFirmwareStatusNotification("Idle"),
        );
        return { status: "Accepted" };

      default:
        return { status: "NotImplemented" };
    }
  }
}
