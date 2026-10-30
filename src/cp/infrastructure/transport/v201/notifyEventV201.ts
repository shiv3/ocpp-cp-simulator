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
 * A whole NotifyEvent report, before it is cut into parts: what the
 * offline queue stores (N07.FR.04, #538), as JSON. `eventData` has the 2.1
 * shape, a superset of 2.0.1's: the parts drop `severity` for 2.0.1, so a
 * report queued under one version still replays valid under the other.
 */
export interface NotifyEventReport {
  readonly generatedAt: string;
  readonly eventData: readonly [EventData, ...EventData[]];
}

/**
 * The report of `events` (non-empty). Each eventData names the monitor
 * that fired (N07.FR.06), with the monitor's component (and so its EVSE
 * scope) and, when the event is linked to one, the transactionId (#538).
 * `cleared` is only written when true. `generatedAt` is the first event's
 * timestamp.
 */
export function buildNotifyEventReport(
  events: readonly [MonitoringEvent, ...MonitoringEvent[]],
): NotifyEventReport {
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
    severity: event.monitor.severity,
  })) as [EventData, ...EventData[]];
  return { generatedAt: events[0].timestamp.toISOString(), eventData };
}

/**
 * The NotifyEvent.req parts of `report`, in order. The parts share
 * `generatedAt`; the first has seqNo 0 (N07.FR.07) and every part but the
 * last has `tbc` true. 2.1 keeps the monitor's severity (N07.FR.20), which
 * the 2.0.1 schema does not allow.
 */
export function notifyEventReportParts(
  report: NotifyEventReport,
  dialect: MonitoringReportDialect,
  itemsPerPart: number = MONITORING_ITEMS_PER_PART,
): NotifyEventPayload[] {
  const eventData = report.eventData.map((data): EventData => {
    if (dialect === "v21") return data;
    const { severity: _severity, ...v201 } = data;
    return v201;
  }) as [EventData, ...EventData[]];
  return splitIntoParts(eventData, itemsPerPart).map(
    ({ items, seqNo, tbc }) => ({
      generatedAt: report.generatedAt,
      seqNo,
      tbc,
      eventData: [...items] as [EventData, ...EventData[]],
    }),
  );
}

/** The NotifyEvent.req parts reporting `events` (non-empty), in order. */
export function buildNotifyEventRequests(
  events: readonly [MonitoringEvent, ...MonitoringEvent[]],
  dialect: MonitoringReportDialect,
  itemsPerPart: number = MONITORING_ITEMS_PER_PART,
): NotifyEventPayload[] {
  return notifyEventReportParts(
    buildNotifyEventReport(events),
    dialect,
    itemsPerPart,
  );
}
