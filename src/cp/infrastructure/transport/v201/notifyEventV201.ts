// OCPP 2.0.1 / 2.1 NotifyEvent.req for variable-monitor events (N07, #457).
import type {
  NotifyEventRequestV201,
  NotifyEventRequestV21,
} from "../../../../ocpp";
import type { MonitoringEvent } from "../../../domain/monitoring/MonitorEvaluation";
import type { MonitoringReportDialect } from "./variableMonitoringV201";

export type NotifyEventPayload = NotifyEventRequestV201 | NotifyEventRequestV21;

type EventData = NotifyEventRequestV21["eventData"][number];

/**
 * One NotifyEvent.req carrying every event of `events` (non-empty), in
 * order. Each eventData names the monitor that fired (N07.FR.06); the
 * request is the first and only part of its report (seqNo 0, N07.FR.07).
 * `cleared` is only written when true; 2.1 adds the monitor's severity
 * (N07.FR.20), which the 2.0.1 schema does not allow.
 */
export function buildNotifyEventRequest(
  events: readonly [MonitoringEvent, ...MonitoringEvent[]],
  dialect: MonitoringReportDialect,
): NotifyEventPayload {
  const eventData = events.map((event): EventData => ({
    eventId: event.eventId,
    timestamp: event.timestamp.toISOString(),
    trigger: event.trigger,
    actualValue: event.actualValue,
    ...(event.cleared && { cleared: true }),
    component: event.monitor.component,
    variable: event.monitor.variable,
    variableMonitoringId: event.monitor.id,
    eventNotificationType: event.monitor.origin,
    ...(dialect === "v21" && { severity: event.monitor.severity }),
  }));
  return {
    generatedAt: events[0].timestamp.toISOString(),
    seqNo: 0,
    tbc: false,
    eventData: eventData as [EventData, ...EventData[]],
  };
}
