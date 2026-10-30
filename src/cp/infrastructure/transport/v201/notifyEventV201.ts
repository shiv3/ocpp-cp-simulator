// OCPP 2.0.1 / 2.1 NotifyEvent.req for variable-monitor events (N07, #457).
import type {
  NotifyEventRequestV201,
  NotifyEventRequestV21,
} from "../../../../ocpp";
import type { MonitoringEvent } from "../../../domain/monitoring/MonitorEvaluation";
import { MONITORING_ITEMS_PER_PART, splitIntoParts } from "./reportParts";
import type { MonitoringReportDialect } from "./variableMonitoringV201";

export type NotifyEventPayload = NotifyEventRequestV201 | NotifyEventRequestV21;

type EventData = NotifyEventRequestV21["eventData"][number];

/**
 * The NotifyEvent.req parts reporting `events` (non-empty), in order. Each
 * eventData names the monitor that fired (N07.FR.06), with the monitor's
 * component (and so its EVSE scope) and, when the event is linked to one,
 * the transactionId (#538). The parts share `generatedAt`; the first has
 * seqNo 0 (N07.FR.07) and every part but the last has `tbc` true.
 * `cleared` is only written when true; 2.1 adds the monitor's severity
 * (N07.FR.20), which the 2.0.1 schema does not allow.
 */
export function buildNotifyEventRequests(
  events: readonly [MonitoringEvent, ...MonitoringEvent[]],
  dialect: MonitoringReportDialect,
  itemsPerPart: number = MONITORING_ITEMS_PER_PART,
): NotifyEventPayload[] {
  const eventData = events.map((event): EventData => ({
    eventId: event.eventId,
    timestamp: event.timestamp.toISOString(),
    trigger: event.trigger,
    actualValue: event.actualValue,
    ...(event.cleared && { cleared: true }),
    ...(event.transactionId !== undefined && {
      transactionId: event.transactionId,
    }),
    component: event.monitor.component,
    variable: event.monitor.variable,
    variableMonitoringId: event.monitor.id,
    eventNotificationType: event.monitor.origin,
    ...(dialect === "v21" && { severity: event.monitor.severity }),
  })) as [EventData, ...EventData[]];
  const generatedAt = events[0].timestamp.toISOString();
  return splitIntoParts(eventData, itemsPerPart).map(
    ({ items, seqNo, tbc }) => ({
      generatedAt,
      seqNo,
      tbc,
      eventData: [...items] as [EventData, ...EventData[]],
    }),
  );
}
