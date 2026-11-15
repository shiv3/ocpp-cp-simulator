import { LogType, type Logger } from "../../shared/Logger";
import type { EventEmitter } from "../../shared/EventEmitter";
import type { SimClock } from "../../shared/clock";
import type { MonitorEvaluation } from "../monitoring/MonitorEvaluation";
import type { Outbox } from "../transport/Outbox";
import { OCPPStatus } from "../types/OcppTypes";
import type { BootReason } from "../types/OcppTypes";
import type { ChargePoint } from "./ChargePoint";
import type {
  BootNotificationResult,
  ChargePointEvents,
  RegistrationStatus,
} from "./ChargePointEvents";
import type { ClockAlignedMeterScheduler } from "./ClockAlignedMeterScheduler";
import type { ConfigurationStore } from "./ConfigurationStore";
import type { PowerLossController } from "./PowerLossController";
import type { ReconnectPolicy } from "../../shared/ReconnectPolicy";

/** The boot facts the charge point shares with the boot lifecycle: they are
 *  also read and written by `boot()`, the socket open and the teardown, so
 *  the charge point keeps the fields and exposes them here. */
export interface BootState {
  bootAccepted: boolean;
  bootReason: BootReason;
  bootedWith: string | null;
  bootSentFingerprint: string | null;
  bootUnanswered: boolean;
}

/** What the boot lifecycle needs from its charge point. */
export interface BootLifecycleHost {
  /** Public members go through it so spies on the charge point still see
   *  them. */
  readonly chargePoint: Pick<
    ChargePoint,
    | "boot"
    | "connectors"
    | "engine"
    | "startHeartbeat"
    | "status"
    | "stopHeartbeat"
    | "updateConnectorStatus"
  >;
  readonly state: BootState;
  readonly clearOutage: () => void;
  readonly clock: () => SimClock;
  readonly clockAligned: () => ClockAlignedMeterScheduler;
  readonly configuration: () => ConfigurationStore;
  readonly events: () => EventEmitter<ChargePointEvents>;
  readonly logger: () => Logger;
  readonly monitorEvaluation: () => MonitorEvaluation | undefined;
  readonly ocppVersion: () => string;
  readonly outbox: () => Outbox;
  readonly power: () => PowerLossController;
  readonly reconnectPolicy: () => ReconnectPolicy;
  readonly txEndedAligned: () => ClockAlignedMeterScheduler;
}

/**
 * The BootNotification gate: what each answer (Accepted, Pending, Rejected)
 * does, the retry budget (#609) and the effects of an Accepted boot. Owns
 * the retry counter and the pending startup event (#734); the charge point
 * keeps the public methods as thin delegates.
 */
export class BootLifecycle {
  /** #609: automatic BootNotification re-sends since the last Accepted. */
  bootRetries = 0;
  /** #734: the device has (re)started and has not reported it yet. */
  startupEventPending = true;
  /** A boot give-up waiting for its `bootNotificationResult` to be emitted. */
  private _bootGaveUp: number | null = null;

  constructor(private readonly host: BootLifecycleHost) {}

  /** Boot-notification gate accessors used by BootNotificationResultHandler. */
  markBootAccepted(): void {
    this.host.state.bootReason = "PowerUp";
    this.host.state.bootAccepted = true;
    this.host.outbox().setBootStatus({ status: "Accepted" });
    if (this.host.ocppVersion() === "OCPP-1.6J") {
      // #734 A04.FR.02: events raised while the station could not send them
      // (ResetOrReboot among them) go out first, with their own timestamps.
      this.host.outbox().flushQueuedSecurityEvents();
      // StartupOfTheDevice reports a start of the device: once per process
      // start, per reset and per power restore, not per reconnect or
      // triggered boot. It is
      // consumed by the first Accepted boot either way, so a later change of
      // the security profile does not report a startup that already passed.
      if (this.startupEventPending) {
        this.startupEventPending = false;
        if (
          (this.host.configuration().getInteger("SecurityProfile") ?? 0) >= 1
        ) {
          void this.host
            .outbox()
            .sendSecurityEventNotification("StartupOfTheDevice");
        }
      }
    }
    // §4.7/§4.8/§4.10 + errata 3.18: flush queued transaction-related
    // messages now that the boot gate is open. Run via queueMicrotask so
    // any post-boot StatusNotification fan-out goes first.
    queueMicrotask(() => this.host.outbox().flushPendingQueue());
    // After the post-boot status fan-out, and with the gate already open.
    queueMicrotask(() => this.host.chargePoint.engine.bootAccepted());
  }

  markBootPending(): void {
    this.host.state.bootAccepted = false;
    this.host.outbox().setBootStatus({ status: "Pending" });
  }

  markBootRejected(retryAfterSeconds: number): void {
    this.host.state.bootAccepted = false;
    this.host.outbox().setBootStatus({
      status: "Rejected",
      retryAfter: new Date(this.host.clock().now() + retryAfterSeconds * 1000),
    });
    // #609: `bootRetryLimit` caps the automatic re-sends (-1: no cap).
    const limit = this.host.reconnectPolicy().bootRetryLimit;
    if (limit >= 0 && this.bootRetries >= limit) {
      this.host
        .logger()
        .warn(
          `Giving up BootNotification after ${this.bootRetries} retr${this.bootRetries === 1 ? "y" : "ies"} (reconnect.bootRetryLimit=${limit})`,
          LogType.OCPP,
        );
      // Reported once `bootNotificationResult` (Rejected), its cause, is out.
      this._bootGaveUp = this.bootRetries;
      return;
    }
    this.bootRetries++;
    // Re-send BootNotification.req once the interval elapses (§4.2).
    this.host.clock().setTimeout(() => {
      this.host.chargePoint.boot();
    }, retryAfterSeconds * 1000);
  }

  /**
   * The single entry point for a processed BootNotification.conf, whatever
   * the OCPP version or transport. A status outside the three the spec
   * defines is treated as Rejected. The boot gate takes the new status first,
   * then `bootNotificationResult` is emitted, then the answer's own effects
   * run — so the event precedes every status change it causes (#395).
   */
  onBootNotificationResult(result: BootNotificationResult): void {
    this.host.state.bootUnanswered = false;
    const status: RegistrationStatus =
      result.status === "Accepted" || result.status === "Pending"
        ? result.status
        : "Rejected";
    const interval =
      typeof result.interval === "number" && result.interval > 0
        ? result.interval
        : 0;
    switch (status) {
      case "Accepted":
        this.bootRetries = 0;
        this.host.logger().info("Boot notification accepted", LogType.OCPP);
        this.host.state.bootedWith = this.host.state.bootSentFingerprint;
        this.host.clearOutage();
        this.markBootAccepted();
        break;
      case "Pending":
        this.host.state.bootedWith = null;
        this.host
          .logger()
          .warn(
            `BootNotification Pending — only CSMS-initiated traffic allowed${
              interval > 0 ? `, retry interval=${interval}s` : ""
            }`,
            LogType.OCPP,
          );
        // Spec: stay quiet but keep the WebSocket open. No retry timer here;
        // CSMS can move us to Accepted/Rejected via subsequent flow.
        this.markBootPending();
        break;
      case "Rejected": {
        this.host.state.bootedWith = null;
        const wait = interval > 0 ? interval : 60;
        this.host
          .logger()
          .error(
            `BootNotification Rejected — silent for ${wait}s before retry`,
            LogType.OCPP,
          );
        this.markBootRejected(wait);
        break;
      }
    }
    // The CSMS's interval, not the 60s retry a Rejected with 0 falls back to.
    this.host.events().emit("bootNotificationResult", {
      status,
      interval,
      currentTime: result.currentTime,
    });
    if (this._bootGaveUp !== null) {
      const attempts = this._bootGaveUp;
      this._bootGaveUp = null;
      this.host
        .events()
        .emit("gaveUp", { target: "boot_notification", attempts });
    }
    if (status === "Accepted") {
      this.applyBootAccepted(interval);
    } else {
      this.host.chargePoint.stopHeartbeat();
      this.host.clockAligned().disable();
      this.host.txEndedAligned().disable();
      // B02.FR.02: no NotifyEvent until the boot is Accepted.
      this.host.monitorEvaluation()?.setReporting(false);
    }
  }

  private applyBootAccepted(interval: number): void {
    // Send connector 0 (charge point level) status first
    this.host.chargePoint.updateConnectorStatus(0, OCPPStatus.Available);
    // #455: a transaction the power-loss recovery is about to end was already
    // decided at the loss. Reporting its pre-loss status (Charging) after the
    // reboot would suggest energy flowed after the restart, so the recovery's
    // own Finishing / Available is the first thing the CSMS hears (#811).
    const ending = this.host.power().connectorsEndedByPowerRecovery();
    this.host.chargePoint.connectors.forEach((connector) => {
      if (ending.has(connector.id)) return;
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
        connector.availability !== "Inoperative" &&
        connector.autoResetToAvailable &&
        !connector.hasRunningTransaction
      ) {
        this.host.chargePoint.updateConnectorStatus(
          connector.id,
          OCPPStatus.Available,
        );
        return;
      }
      this.host.chargePoint.updateConnectorStatus(
        connector.id,
        connector.status,
      );
    });
    this.host.chargePoint.status = OCPPStatus.Available;

    if (interval > 0) {
      this.host.chargePoint.startHeartbeat(interval);
      this.host
        .logger()
        .info(
          `Periodic Heartbeat enabled at ${interval}s interval`,
          LogType.HEARTBEAT,
        );
    } else {
      this.host.chargePoint.stopHeartbeat();
    }

    this.host.clockAligned().enable();
    this.host.txEndedAligned().enable();
    // #455: after the status fan-out and the flush of the queue (both
    // already scheduled), so the recovery's messages come last.
    queueMicrotask(() => this.host.power().runPowerRecovery());
    // Re-checks the thresholds: what changed while Pending or offline, and
    // a restored trigger already back in range (N07.FR.14).
    this.host.monitorEvaluation()?.setReporting(true);
  }
}
