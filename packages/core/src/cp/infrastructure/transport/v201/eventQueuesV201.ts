import type { SecurityEventNotificationRequestV201 } from "@ocpp-cp-simulator/ocpp/index";
import type { Logger } from "../../../shared/Logger";
import { LogType } from "../../../shared/Logger";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import { clockOf } from "../../../shared/clock";
import type { SimClock } from "../../../shared/clock";
import { OcppCallNoAnswerError } from "../../../domain/errors/OcppCallErrors";
import { isCriticalSecurityEvent } from "../../../domain/security/securityEvents";
import type { MonitoringEvent } from "../../../domain/monitoring/MonitorEvaluation";
import { isQueuedOffline } from "../../../domain/monitoring/monitoringCtrlrKeys";
import { OCPP_2_1 } from "../../../domain/types/OcppVersion";
import type {
  PendingMessage,
  PendingMessageQueue,
} from "../../../domain/transport/PendingMessageQueue";
import type { OCPPWebSocket } from "../OCPPWebSocket";
import {
  buildNotifyEventReport,
  buildNotifyEventRequests,
  notifyEventReportParts,
  type NotifyEventReport,
} from "./notifyEventV201";
import type { V201Action, V201RequestPayload } from "./inboundRegistryV201";
import type { V201QueuedAction } from "./offlineReplayV201";

/**
 * #538: most NotifyEvent reports the offline queue keeps per charge point.
 * A Periodic monitor ticking through a long outage would otherwise grow the
 * persisted queue without bound; past the cap the oldest report made only
 * of Periodic events goes, else the oldest report. The TransactionEvents
 * queued under E11 are not counted and never dropped.
 */
export const MAX_QUEUED_NOTIFY_EVENTS = 1000;

/**
 * #552: most SecurityEventNotification requests the offline queue keeps
 * per charge point. Critical events are rare; the cap only bounds the
 * persisted queue of a station that loops on one through a long outage.
 * Past it the oldest queued event goes.
 */
export const MAX_QUEUED_SECURITY_EVENTS = 1000;

/** Whether a queued NotifyEvent report holds only periodic ticks, whose
 *  loss the next tick makes up for. */
function isPeriodicOnlyReport(payload: unknown): boolean {
  return (payload as NotifyEventReport).eventData.every(
    (data) => data.trigger === "Periodic",
  );
}

/** A written CALL whose loss a close must make good until its answer
 *  comes (#664). */
export interface UnansweredDelivery {
  onAnswer: () => void;
  onLost: () => void;
}

/** What the SecurityEventNotification and NotifyEvent queues need from
 *  the handler. */
export interface EventQueuesContext {
  readonly chargePoint: Pick<
    ChargePoint,
    "clock" | "configuration" | "ocppVersion"
  >;
  readonly logger: Logger;
  readonly webSocket: Pick<OCPPWebSocket, "isConnected">;
  /** The E11 offline queue (#528). */
  readonly pendingQueue: PendingMessageQueue<V201QueuedAction>;
  /** The handler's written CALLs a close must make good, by message id. */
  readonly unansweredDeliveries: Pick<
    Map<string, UnansweredDelivery>,
    "set" | "delete"
  >;
  generateMessageId(): string;
  send(
    action: V201Action,
    messageId: string,
    payload: V201RequestPayload,
    onDropped?: (reason: string) => void,
    transactionEvent?: undefined,
    onWritten?: () => void,
  ): void;
}

/**
 * A04 SecurityEventNotification and N07 NotifyEvent on 2.x: sent online,
 * queued offline in the E11 table under their caps (#538, #552), and
 * replayed after the next Boot Accepted, each row kept until the CSMS
 * answers (#664, #877).
 */
export class EventQueuesV201 {
  private readonly _chargePoint: EventQueuesContext["chargePoint"];
  private readonly _logger: Logger;
  private readonly _webSocket: EventQueuesContext["webSocket"];
  private readonly _pendingQueue: PendingMessageQueue<V201QueuedAction>;
  private readonly _unansweredDeliveries: EventQueuesContext["unansweredDeliveries"];
  /** NotifyEvent reports dropped from the full queue since the last
   *  replay (#538); reported and reset by `flushPendingQueue`. */
  private _droppedNotifyEvents = 0;
  /** SecurityEventNotification requests dropped from the full queue since
   *  the last flush (#552). */
  private _droppedSecurityEvents = 0;

  constructor(private readonly ctx: EventQueuesContext) {
    this._chargePoint = ctx.chargePoint;
    this._logger = ctx.logger;
    this._webSocket = ctx.webSocket;
    this._pendingQueue = ctx.pendingQueue;
    this._unansweredDeliveries = ctx.unansweredDeliveries;
  }

  /** The charge point's clock (the platform clock for a stand-in without one). */
  private get clock(): SimClock {
    return clockOf(this._chargePoint);
  }

  private generateMessageId(): string {
    return this.ctx.generateMessageId();
  }

  private send(
    action: V201Action,
    messageId: string,
    payload: V201RequestPayload,
    onDropped?: (reason: string) => void,
    transactionEvent?: undefined,
    onWritten?: () => void,
  ): void {
    this.ctx.send(
      action,
      messageId,
      payload,
      onDropped,
      transactionEvent,
      onWritten,
    );
  }

  /**
   * A04 SecurityEventNotificationRequest (#537), sent by the control-plane
   * `security_event_notification` method. While offline (A04.FR.02, #552) a
   * critical event ({@link isCriticalSecurityEvent}) is queued with the time
   * it happened and sent after the next Boot Accepted, and this resolves
   * once it is queued; any other event is dropped. Online it resolves once
   * the CALL is written, not answered. A critical event whose CALL the
   * pipeline drops because the socket closed or the write failed is queued
   * too; any other dropped CALL rejects with `OcppCallNoAnswerError`.
   */
  public sendSecurityEventNotification(
    type: string,
    techInfo?: string,
  ): Promise<void> {
    const payload: SecurityEventNotificationRequestV201 = {
      type,
      timestamp: new Date(this.clock.now()).toISOString(),
      ...(techInfo !== undefined ? { techInfo } : {}),
    };
    if (!this._webSocket.isConnected() && isCriticalSecurityEvent(type)) {
      this.queueSecurityEvent(payload);
      return Promise.resolve();
    }
    const id = this.generateMessageId();
    return new Promise((resolve, reject) => {
      this.send(
        "SecurityEventNotification",
        id,
        payload,
        (reason) => {
          // The socket was up at call time but the CALL never left it
          // (A04.FR.02, #552): a critical event is queued like an offline one.
          // A behavior that dropped it on purpose, a full pipeline queue and a
          // disposed handler stay dropped.
          if (
            isCriticalSecurityEvent(type) &&
            (reason === "socket_closed" || reason === "write_failed")
          ) {
            this.queueSecurityEvent(payload);
            resolve();
            return;
          }
          reject(
            new OcppCallNoAnswerError(
              "dropped",
              `OCPP call ${id} dropped (${reason})`,
            ),
          );
        },
        undefined,
        () => {
          // #664: written is not delivered. A critical event whose connection
          // closes before the answer is queued like an offline one.
          if (isCriticalSecurityEvent(type)) {
            this._unansweredDeliveries.set(id, {
              onAnswer: () => undefined,
              onLost: () => this.queueSecurityEvent(payload),
            });
          }
          resolve();
        },
      );
    });
  }

  /**
   * #552, OCPP 2.0.1 / 2.1 A04.FR.02: queue a critical security event while
   * offline, in the E11 queue (#528), so it is persisted when state
   * persistence is on. The timestamp stays the one of the event. Past
   * {@link MAX_QUEUED_SECURITY_EVENTS} the oldest queued event goes.
   */
  private queueSecurityEvent(payload: SecurityEventNotificationRequestV201) {
    while (
      this._pendingQueue.countOf("SecurityEventNotification") >=
        MAX_QUEUED_SECURITY_EVENTS &&
      this._pendingQueue.removeOldest("SecurityEventNotification")
    ) {
      if (this._droppedSecurityEvents === 0) {
        this._logger.warn(
          `[v2.0.1] Offline SecurityEventNotification queue full (${MAX_QUEUED_SECURITY_EVENTS}): dropping the oldest events until the connection is back`,
          LogType.OCPP,
        );
      }
      this._droppedSecurityEvents += 1;
    }
    this._pendingQueue.enqueue({
      action: "SecurityEventNotification",
      payload,
    });
    this._logger.info(
      `[v2.0.1] Not connected, queued critical SecurityEventNotification ${payload.type} (A04.FR.02); queue size=${this._pendingQueue.size()}`,
      LogType.OCPP,
    );
  }

  /** N07 NotifyEvent.req: the events of one monitor evaluation (#457), in
   *  as many parts as `buildNotifyEventRequests` makes, sent in order
   *  (#538). Events the monitor evaluation produced online but that find
   *  the socket already down are queued per `OfflineQueuingSeverity`
   *  (N07.FR.04), the others dropped. */
  public sendNotifyEvent(events: readonly MonitoringEvent[]): void {
    const [first, ...rest] = events;
    if (first === undefined) return;
    if (!this._webSocket.isConnected()) {
      const threshold =
        this._chargePoint.configuration.offlineQueuingSeverity();
      const queued = events.filter((event) =>
        isQueuedOffline(event.monitor.severity, threshold),
      );
      this.queueNotifyEvent(queued);
      if (queued.length < events.length) {
        this._logger.warn(
          `[v2.0.1] Not connected, dropping ${events.length - queued.length} NotifyEvent event(s) above OfflineQueuingSeverity ${threshold}`,
          LogType.WEBSOCKET,
        );
      }
      return;
    }
    for (const part of buildNotifyEventRequests(
      [first, ...rest],
      this.notifyEventDialect(),
    )) {
      this.send("NotifyEvent", this.generateMessageId(), part);
    }
  }

  /**
   * #538, OCPP 2.0.1 / 2.1 N07.FR.04, N08.FR.03: queue the NotifyEvent of
   * `events` while offline, as one whole report in the E11 queue (#528),
   * cut into parts when it is replayed after the next Boot Accepted. The
   * caller has applied `OfflineQueuingSeverity`.
   */
  public queueNotifyEvent(events: readonly MonitoringEvent[]): void {
    const [first, ...rest] = events;
    if (first === undefined) return;
    this.makeRoomForNotifyEvent();
    this._pendingQueue.enqueue({
      action: "NotifyEvent",
      payload: buildNotifyEventReport([first, ...rest]),
    });
    // Debug, not warn: a Periodic monitor ticking through an outage would
    // flood the log with one line per report.
    this._logger.debug(
      `[v2.0.1] NotifyEvent with ${events.length} event(s) queued while offline; queue size=${this._pendingQueue.size()}`,
      LogType.OCPP,
    );
  }

  /** #538: the highest `eventId` of the NotifyEvent reports still queued,
   *  0 when none, so a restarted station numbers its events past them. */
  public highestQueuedNotifyEventId(): number {
    let highest = 0;
    for (const queued of this._pendingQueue.all()) {
      if (queued.action !== "NotifyEvent") continue;
      for (const data of (queued.payload as NotifyEventReport).eventData) {
        highest = Math.max(highest, data.eventId);
      }
    }
    return highest;
  }

  /**
   * #538: keep the queued NotifyEvent reports under
   * {@link MAX_QUEUED_NOTIFY_EVENTS} by dropping the oldest report made
   * only of Periodic events, else the oldest report: a threshold crossing
   * queued offline counts as told, so the re-check of the Accepted boot
   * would never send it again. A TransactionEvent row is never dropped.
   * The first drop of an outage warns; `flushPendingQueue` reports the
   * total once the station is back.
   */
  private makeRoomForNotifyEvent(): void {
    while (
      this._pendingQueue.countOf("NotifyEvent") >= MAX_QUEUED_NOTIFY_EVENTS &&
      (this._pendingQueue.removeOldest("NotifyEvent", isPeriodicOnlyReport) ||
        this._pendingQueue.removeOldest("NotifyEvent"))
    ) {
      if (this._droppedNotifyEvents === 0) {
        this._logger.warn(
          `[v2.0.1] Offline NotifyEvent queue full (${MAX_QUEUED_NOTIFY_EVENTS} reports): dropping the oldest reports until the connection is back`,
          LogType.OCPP,
        );
      }
      this._droppedNotifyEvents += 1;
    }
  }

  private notifyEventDialect(): "v21" | "v201" {
    return this._chargePoint.ocppVersion === OCPP_2_1 ? "v21" : "v201";
  }

  /** #538, #552: report the queued reports and events the caps dropped
   *  during the outage. */
  public reportOutageDrops(): void {
    if (this._droppedNotifyEvents > 0) {
      this._logger.warn(
        `[v2.0.1] Dropped ${this._droppedNotifyEvents} queued NotifyEvent report(s) during the outage (cap ${MAX_QUEUED_NOTIFY_EVENTS})`,
        LogType.OCPP,
      );
      this._droppedNotifyEvents = 0;
    }
    if (this._droppedSecurityEvents > 0) {
      this._logger.warn(
        `[v2.0.1] Dropped ${this._droppedSecurityEvents} queued SecurityEventNotification(s) during the outage (cap ${MAX_QUEUED_SECURITY_EVENTS})`,
        LogType.OCPP,
      );
      this._droppedSecurityEvents = 0;
    }
  }

  /**
   * #538: send a queued NotifyEvent report, in parts cut now (seqNo from 0,
   * N07.FR.07), with no offline marker: NotifyEventRequest has none. A
   * first part the socket refuses keeps the whole row at the head, like a
   * refused TransactionEvent; a later part refused loses the rest of the
   * report, with a warning. #664: the row stays in the table until every
   * part sent is answered; a close or a drop before that puts it back for
   * the next replay.
   */
  public replayNotifyEvent(
    queued: PendingMessage<V201QueuedAction>,
    rowId: string,
  ): "replayed" | "held" {
    const parts = notifyEventReportParts(
      queued.payload as NotifyEventReport,
      this.notifyEventDialect(),
    );
    const group = this.newRowDelivery(rowId);
    for (const [index, part] of parts.entries()) {
      let refused = false;
      let sending = true;
      const id = this.generateMessageId();
      group.expect(id);
      this.send(
        "NotifyEvent",
        id,
        part,
        (reason) => {
          group.dropped(id, reason);
          // A drop a behavior's beforeSend asked for is spent, not refused.
          if (!sending) return;
          if (reason === "dropped_by_behavior") {
            this._logger.warn(
              `[v2.0.1] Replay of a queued NotifyEvent part ${index + 1} dropped by a behavior's beforeSend`,
              LogType.OCPP,
            );
          } else refused = true;
        },
        undefined,
        () => group.written(id),
      );
      sending = false;
      if (!refused) continue;
      if (index === 0) {
        this._logger.warn(
          `[v2.0.1] Replay of a queued NotifyEvent refused by the socket; kept at the head of the queue (size=${this._pendingQueue.size()})`,
          LogType.OCPP,
        );
        group.abandon();
        return "held";
      }
      this._logger.warn(
        `[v2.0.1] Replay of a queued NotifyEvent refused at part ${index + 1} of ${parts.length}; the rest of the report is lost`,
        LogType.OCPP,
      );
      break;
    }
    group.seal();
    return "replayed";
  }

  /**
   * #552: send a queued SecurityEventNotification (A04.FR.02) as it was
   * built, with the time of the event. The request has no offline marker. A
   * CALL the socket refuses while it stays open keeps the row at the head
   * and stops the replay, like a refused TransactionEvent; one a behavior's
   * beforeSend withdrew is spent. #664: the row stays in the table until the
   * CSMS answers; a close or a drop before that puts it back for the next
   * replay.
   */
  public replaySecurityEvent(
    queued: PendingMessage<V201QueuedAction>,
    rowId: string,
  ): "replayed" | "held" {
    let refused = false;
    let sending = true;
    const group = this.newRowDelivery(rowId);
    const id = this.generateMessageId();
    group.expect(id);
    this.send(
      "SecurityEventNotification",
      id,
      queued.payload as SecurityEventNotificationRequestV201,
      (reason) => {
        group.dropped(id, reason);
        if (!sending) return;
        if (reason === "dropped_by_behavior") {
          this._logger.warn(
            "[v2.0.1] Replay of a queued SecurityEventNotification dropped by a behavior's beforeSend",
            LogType.OCPP,
          );
        } else refused = true;
      },
      undefined,
      () => group.written(id),
    );
    sending = false;
    if (refused) {
      this._logger.warn(
        `[v2.0.1] Replay of a queued SecurityEventNotification refused by the socket; kept at the head of the queue (size=${this._pendingQueue.size()})`,
        LogType.OCPP,
      );
      group.abandon();
      return "held";
    }
    group.seal();
    return "replayed";
  }

  /**
   * #664: the delivery of one E11 row made of CALLs that are not
   * TransactionEvents (no E13 resend of their own). The row is marked
   * delivering at once and removed once every CALL expected is answered. A
   * close, or a drop other than a behavior's own, before that releases the
   * row so the next replay sends it again; the rows are not lost behind the
   * §4.1.1 queue (#802).
   */
  private newRowDelivery(rowId: string) {
    const open = new Set<string>();
    let sealed = false;
    let ended = false;
    const queue = this._pendingQueue;
    const finish = (remove: boolean) => {
      if (ended) return;
      ended = true;
      for (const id of open) this._unansweredDeliveries.delete(id);
      open.clear();
      if (remove) queue.remove(rowId);
      else queue.release(rowId);
    };
    return {
      expect: (id: string) => open.add(id),
      /** The CALL is on the wire: a close before its answer releases the row. */
      written: (id: string) => {
        if (ended) return;
        this._unansweredDeliveries.set(id, {
          onAnswer: () => {
            open.delete(id);
            if (sealed && open.size === 0) finish(true);
          },
          onLost: () => finish(false),
        });
      },
      dropped: (id: string, reason: string) => {
        if (ended) return;
        if (reason === "dropped_by_behavior") {
          // Withdrawn on purpose: this part is spent.
          open.delete(id);
          if (sealed && open.size === 0) finish(true);
          return;
        }
        // Refused at the hand-over: the caller decides (abandon, or the rest
        // of a report is lost); refused or lost later: the row waits for the
        // next replay.
        open.delete(id);
        if (sealed) finish(false);
      },
      /** All CALLs are handed over: mark the row delivering. */
      seal: () => {
        if (ended) return;
        sealed = true;
        if (open.size === 0) finish(true);
        else queue.markDelivering(rowId);
      },
      /** The first CALL was refused: the row stays idle at the head. */
      abandon: () => {
        ended = true;
        for (const id of open) this._unansweredDeliveries.delete(id);
        open.clear();
      },
    };
  }
}
