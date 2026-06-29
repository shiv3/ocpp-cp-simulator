import { CallResultHandler, HandlerContext } from "../MessageHandlerRegistry";
import type { BootNotificationResponseV16 } from "../../../../../ocpp";

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
  implements CallResultHandler<BootNotificationResponseV16>
{
  handle(payload: BootNotificationResponseV16, context: HandlerContext): void {
    const interval =
      typeof payload.interval === "number" && payload.interval > 0
        ? payload.interval
        : 0;

    switch (payload.status) {
      case "Accepted": {
        context.chargePoint.onBootNotificationAccepted(
          payload.currentTime,
          interval,
        );
        break;
      }
      case "Pending": {
        context.chargePoint.onBootNotificationPending(interval);
        break;
      }
      case "Rejected":
      default: {
        context.chargePoint.onBootNotificationRejected(interval);
        break;
      }
    }
  }
}
