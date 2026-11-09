// OCPP 1.6 Security Whitepaper SecurityEventNotification.req of
// OCPPMessageHandler (#877), with the A04.FR.02 offline queue of critical
// events (#734).
import type { SecurityEventNotificationRequestV16 } from "@ocpp-cp-simulator/ocpp/index";
import { isCriticalSecurityEvent16 } from "../../../domain/security/securityEvents16";
import type { ChargePoint } from "../../../domain/charge-point/ChargePoint";
import type { PendingMessageQueue } from "../../../domain/transport/PendingMessageQueue";
import type { BootGate } from "../../../application/state/machines/BootGate";
import type {
  OCPPWebSocket,
  OcppMessageRequestPayload,
} from "../OCPPWebSocket";
import { clockOf } from "../../../shared/clock";
import type { SimClock } from "../../../shared/clock";
import type { Logger } from "../../../shared/Logger";
import { LogType } from "../../../shared/Logger";
import { OCPPAction } from "../../../domain/types/OcppTypes";
import type { SerialCallQueueV16 } from "./serialCallQueueV16";

/** What the security events need from the 1.6 handler. */
export interface SecurityEventQueueV16Context {
  /** The charge point object itself, for `clockOf`. */
  readonly chargePoint: Pick<ChargePoint, "clock">;
  readonly webSocket: Pick<OCPPWebSocket, "isConnected">;
  readonly logger: Logger;
  readonly bootGate: Pick<BootGate, "isCallAllowed">;
  readonly pendingQueue: Pick<
    PendingMessageQueue,
    "enqueue" | "size" | "all" | "removeOldest"
  >;
  readonly delivery: Pick<SerialCallQueueV16, "sendRequest">;
  readonly generateMessageId: () => string;
}

export class SecurityEventQueueV16 {
  private readonly _chargePoint: SecurityEventQueueV16Context["chargePoint"];
  private readonly _webSocket: SecurityEventQueueV16Context["webSocket"];
  private readonly _logger: Logger;
  private readonly _bootGate: SecurityEventQueueV16Context["bootGate"];
  private readonly _pendingQueue: SecurityEventQueueV16Context["pendingQueue"];
  private readonly _delivery: SecurityEventQueueV16Context["delivery"];
  private readonly _generateMessageId: () => string;

  constructor(context: SecurityEventQueueV16Context) {
    this._chargePoint = context.chargePoint;
    this._webSocket = context.webSocket;
    this._logger = context.logger;
    this._bootGate = context.bootGate;
    this._pendingQueue = context.pendingQueue;
    this._delivery = context.delivery;
    this._generateMessageId = context.generateMessageId;
  }

  /** OCPP 1.6 Security Whitepaper: CP-initiated security event. */
  public sendSecurityEventNotification(
    type: string,
    techInfo?: string,
  ): Promise<void> {
    const payload = this.securityEventPayload(type, techInfo);
    // A04.FR.02: a critical event raised while the station cannot send it
    // (no connection, or the boot not Accepted yet) is queued, with its own
    // timestamp, and goes out after the next Accepted boot.
    if (
      isCriticalSecurityEvent16(type) &&
      (!this._webSocket.isConnected() ||
        !this.isCallAllowed(OCPPAction.SecurityEventNotification))
    ) {
      this.queueSecurityEventPayload(payload);
      return Promise.resolve();
    }
    this._delivery.sendRequest(
      OCPPAction.SecurityEventNotification,
      this.generateMessageId(),
      payload,
    );
    return Promise.resolve();
  }

  /**
   * #734: raises a critical security event now but sends it only after the
   * next Accepted boot (`ResetOrReboot`: the station reports the reset once
   * it is back). Persisted with the other queued messages.
   */
  public queueSecurityEventNotification(type: string, techInfo?: string): void {
    this.queueSecurityEventPayload(this.securityEventPayload(type, techInfo));
  }

  private securityEventPayload(
    type: string,
    techInfo?: string,
  ): SecurityEventNotificationRequestV16 {
    return {
      type,
      timestamp: new Date(this.clock.now()).toISOString(),
      ...(techInfo !== undefined ? { techInfo } : {}),
    };
  }

  private queueSecurityEventPayload(
    payload: SecurityEventNotificationRequestV16,
  ): void {
    this._pendingQueue.enqueue({
      action: OCPPAction.SecurityEventNotification,
      payload,
    });
    this._logger.info(
      `Queued security event ${payload.type} until the next Accepted boot (A04.FR.02); size=${this._pendingQueue.size()}`,
      LogType.OCPP,
    );
  }

  /**
   * #734: sends the queued security events, oldest first, each with the
   * timestamp it was raised with. Called when a boot is Accepted, before any
   * other traffic that follows it.
   */
  public flushQueuedSecurityEvents(): void {
    const queued = this._pendingQueue
      .all()
      .filter((m) => m.action === OCPPAction.SecurityEventNotification);
    for (const message of queued) {
      this._pendingQueue.removeOldest(OCPPAction.SecurityEventNotification);
      this._delivery.sendRequest(
        OCPPAction.SecurityEventNotification,
        this.generateMessageId(),
        message.payload as OcppMessageRequestPayload,
      );
    }
  }

  /** The charge point's clock (the platform clock for a stand-in without one). */
  private get clock(): SimClock {
    return clockOf(this._chargePoint);
  }

  private isCallAllowed(action: OCPPAction): boolean {
    return this._bootGate.isCallAllowed(action);
  }

  private generateMessageId(): string {
    return this._generateMessageId();
  }
}
