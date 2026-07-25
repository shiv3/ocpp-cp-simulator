import { CallHandler, HandlerContext } from "../MessageHandlerRegistry";
import type {
  ExtendedTriggerMessageRequestV16,
  ExtendedTriggerMessageResponseV16,
} from "../../../../../ocpp";
import type { HandlerOutcome } from "../../network-sim/ResponseEffectQueue";
import { LogType } from "../../../../shared/Logger";

/**
 * §2 ExtendedTriggerMessage.req (OCPP 1.6 Security Whitepaper): a superset
 * of TriggerMessage.req (see `OtherCallHandlers.TriggerMessageHandler`)
 * covering the three Security messages plus the original Core set. Same
 * §6.51-style contract — respond Accepted/NotImplemented first, then fire
 * the requested message via a returned HandlerOutcome so the CALLRESULT is on the
 * wire before the new CALL.
 */
export class ExtendedTriggerMessageHandler implements CallHandler<
  ExtendedTriggerMessageRequestV16,
  ExtendedTriggerMessageResponseV16
> {
  handle(
    payload: ExtendedTriggerMessageRequestV16,
    context: HandlerContext,
  ): ExtendedTriggerMessageResponseV16 | HandlerOutcome {
    context.logger.info(
      `Extended trigger message request received: ${payload.requestedMessage}` +
        (payload.connectorId !== undefined
          ? ` (connectorId=${payload.connectorId})`
          : ""),
      LogType.OCPP,
    );

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
        // §5.17 + §4.2: permitted even while the boot gate is
        // Pending/Rejected — same escape hatch as plain TriggerMessage.
        const response = { status: "Accepted" } as const;
        const outcome: HandlerOutcome = {
          kind: "handler-outcome",
          payload: response,
          afterResponseSettled: () => context.chargePoint.boot(),
        };
        return outcome;
      }

      case "SignChargePointCertificate": {
        const response = { status: "Accepted" } as const;
        const outcome: HandlerOutcome = {
          kind: "handler-outcome",
          payload: response,
          afterResponseSettled: () => {
            context.chargePoint.sendSignCertificate().catch((err: unknown) => {
              context.logger.warn(
                `SignChargePointCertificate trigger failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
                LogType.OCPP,
              );
            });
          },
        };
        return outcome;
      }

      case "LogStatusNotification": {
        // Not currently uploading a log — Idle, mirroring the
        // DiagnosticsStatusNotification trigger contract.
        const response = { status: "Accepted" } as const;
        const outcome: HandlerOutcome = {
          kind: "handler-outcome",
          payload: response,
          afterResponseSettled: () =>
            context.chargePoint.sendLogStatusNotification("Idle"),
        };
        return outcome;
      }

      case "FirmwareStatusNotification": {
        const response = { status: "Accepted" } as const;
        const outcome: HandlerOutcome = {
          kind: "handler-outcome",
          payload: response,
          afterResponseSettled: () =>
            context.chargePoint.sendSignedFirmwareStatusNotification("Idle"),
        };
        return outcome;
      }

      default:
        return { status: "NotImplemented" };
    }
  }
}
