import { CallResultHandler, HandlerContext } from "../MessageHandlerRegistry";
import * as response from "@voltbras/ts-ocpp/dist/messages/json/response";
import { OCPPStatus } from "../../../../domain/types/OcppTypes";
import { LogType } from "../../../../shared/Logger";

/**
 * §4.2 BootNotification.conf handling:
 *
 * - **Accepted**: turn on heartbeats, fan out StatusNotification.req for
 *   connector 0 + every individual connector, mark CP Available.
 * - **Pending**: leave heartbeat off; CP MAY respond to CSMS calls but
 *   MUST NOT send unsolicited CALLs (RemoteStartTransaction /
 *   RemoteStopTransaction are also forbidden during Pending). We mark
 *   the boot status on the message handler so its `sendRequest` can gate.
 * - **Rejected**: heartbeat off, no further messages for `interval`
 *   seconds, then auto-retry BootNotification.
 */
export class BootNotificationResultHandler
  implements CallResultHandler<response.BootNotificationResponse>
{
  handle(
    payload: response.BootNotificationResponse,
    context: HandlerContext,
  ): void {
    const interval =
      typeof payload.interval === "number" && payload.interval > 0
        ? payload.interval
        : 0;

    switch (payload.status) {
      case "Accepted": {
        context.logger.info("Boot notification accepted", LogType.OCPP);
        context.chargePoint.markBootAccepted();
        // Send connector 0 (charge point level) status first
        context.chargePoint.updateConnectorStatus(0, OCPPStatus.Available);
        context.chargePoint.connectors.forEach((connector) => {
          // Reset to Available only when this is a fresh post-boot state —
          // i.e. autoReset is enabled AND no transaction is in flight. A
          // connector that was restored from `connector_runtime` with an
          // active transaction must keep its persisted status (typically
          // Preparing → Charging) so the CSMS-side view stays consistent
          // with the resumed transaction id; otherwise the CSMS sees us
          // bounce Charging → Available and the transaction is orphaned.
          // (See `restoreConnectorRuntimeFromDatabase` for the persisted
          // shape and `Connector.restoreRuntimeSnapshot` for how the
          // private fields are restored ahead of this StatusNotification.)
          if (
            connector.autoResetToAvailable &&
            connector.transaction === null
          ) {
            context.chargePoint.updateConnectorStatus(
              connector.id,
              OCPPStatus.Available,
            );
            return;
          }
          context.chargePoint.updateConnectorStatus(
            connector.id,
            connector.status,
          );
        });
        context.chargePoint.status = OCPPStatus.Available;

        if (interval > 0) {
          context.chargePoint.startHeartbeat(interval);
          context.logger.info(
            `Periodic Heartbeat enabled at ${interval}s interval`,
            LogType.HEARTBEAT,
          );
        } else {
          context.chargePoint.stopHeartbeat();
        }
        break;
      }
      case "Pending": {
        context.logger.warn(
          `BootNotification Pending — only CSMS-initiated traffic allowed${
            interval > 0 ? `, retry interval=${interval}s` : ""
          }`,
          LogType.OCPP,
        );
        context.chargePoint.markBootPending();
        context.chargePoint.stopHeartbeat();
        // Spec: stay quiet but keep the WebSocket open. No retry timer here;
        // CSMS can move us to Accepted/Rejected via subsequent flow.
        break;
      }
      case "Rejected":
      default: {
        const wait = interval > 0 ? interval : 60;
        context.logger.error(
          `BootNotification Rejected — silent for ${wait}s before retry`,
          LogType.OCPP,
        );
        context.chargePoint.markBootRejected(wait);
        context.chargePoint.stopHeartbeat();
        break;
      }
    }
  }
}
