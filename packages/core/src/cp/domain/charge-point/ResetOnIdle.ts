import { LogType, type Logger } from "../../shared/Logger";
import type { Connector } from "../connector/Connector";
import type { Outbox } from "../transport/Outbox";
import type { ConfigurationStore } from "./ConfigurationStore";
import type { ChargePointResetType } from "./ChargePointTypes";
import type { ChargePoint } from "./ChargePoint";

/** What the pending-reset queue needs from its charge point. */
export interface ResetOnIdleHost {
  /** Public members go through it so spies on the charge point still see
   *  them. */
  readonly chargePoint: Pick<
    ChargePoint,
    | "boot"
    | "connectors"
    | "id"
    | "isSoapChargePoint"
    | "reset"
    | "resetEvse"
    | "stopTransaction"
  >;
  readonly connectors: () => Map<number, Connector>;
  readonly configuration: () => ConfigurationStore;
  readonly logger: () => Logger;
  readonly ocppVersion: () => string;
  readonly outbox: () => Outbox;
  /** A station without power starts, stops and boots nothing (#798). */
  readonly assertPowered: () => void;
  /** #734: reported once the station is back with an Accepted boot. */
  readonly markStartupEventPending: () => void;
}

/**
 * The Reset OnIdle requests answered `Scheduled` (#597): they wait here
 * until the last targeted transaction ends. The charge point keeps the
 * public methods as thin delegates.
 */
export class ResetOnIdle {
  private _pending: { evseId?: number }[] = [];

  constructor(private readonly host: ResetOnIdleHost) {}

  applyRemoteReset(
    type: ChargePointResetType,
    source: Parameters<ChargePoint["applyRemoteReset"]>[1] = "ocpp-call",
  ): void {
    this.host.assertPowered();
    if (
      source === "ocpp15-soap" &&
      !this.host.chargePoint.isSoapChargePoint()
    ) {
      this.host
        .logger()
        .warn(
          "Ignoring SOAP Reset for a charge point that is not registered as a SOAP charge point",
          LogType.OCPP,
        );
      return;
    }
    const reason = type === "Hard" ? "HardReset" : "SoftReset";
    for (const connector of this.host.chargePoint.connectors.values()) {
      if (connector.transaction) {
        this.host.chargePoint.stopTransaction(connector, reason);
      }
    }
    this.host
      .logger()
      .info(`Reset chargePoint: ${this.host.chargePoint.id}`, LogType.OCPP);
    if (
      this.host.ocppVersion() === "OCPP-1.6J" &&
      (this.host.configuration().getInteger("SecurityProfile") ?? 0) >= 1
    ) {
      // #734: reported once the station is back with an Accepted boot.
      this.host
        .outbox()
        .queueSecurityEventNotification("ResetOrReboot", reason);
    }
    this.host.markStartupEventPending();
    if (type === "Hard") {
      this.host.chargePoint.reset("RemoteReset");
    } else {
      this.host.chargePoint.boot("RemoteReset");
    }
  }

  /**
   * #597: record a Reset OnIdle that was answered `Scheduled`. `evseId`
   * undefined targets every connector. It runs when the last targeted
   * transaction ends (see {@link runPendingResetOnIdle}).
   */
  scheduleResetOnIdle(evseId?: number): void {
    this._pending.push({ evseId });
    // The transaction can end after the handler decided to answer Scheduled
    // but before this callback runs. Recheck after enqueueing to avoid leaving
    // an already-runnable reset stranded until a later transaction ends.
    this.runPendingResetOnIdle();
  }

  /**
   * #597: drop every pending Reset OnIdle. An Immediate reset reboots the
   * station now, which already satisfies them; keeping them would boot
   * again on a later transaction end.
   */
  cancelPendingResetsOnIdle(evseId?: number): void {
    this._pending =
      evseId === undefined
        ? []
        : this._pending.filter((pending) => pending.evseId !== evseId);
  }

  /**
   * #597: boot again once a pending reset has no targeted connector left
   * with a transaction. Called when a transaction ends (the engine's default stop) and when a
   * connector is removed. Each pending
   * reset stays queued while its targets are still busy; the station
   * boots once if any of them became runnable.
   */
  runPendingResetOnIdle(): void {
    if (this._pending.length === 0) return;
    const isBusy = (pending: { evseId?: number }): boolean =>
      [...this.host.connectors().values()].some(
        (connector) =>
          (pending.evseId === undefined || connector.id === pending.evseId) &&
          connector.hasRunningTransaction,
      );
    const remaining = this._pending.filter(isBusy);
    if (remaining.length === this._pending.length) return;
    const runnable = this._pending.filter(
      (pending) => !remaining.includes(pending),
    );
    this._pending = remaining;
    // A station-wide reset reboots everything and subsumes EVSE resets.
    if (runnable.some((pending) => pending.evseId === undefined)) {
      this.host.chargePoint.boot("ScheduledReset");
      return;
    }
    for (const evseId of new Set(runnable.map((pending) => pending.evseId))) {
      if (evseId !== undefined) this.host.chargePoint.resetEvse(evseId);
    }
  }
}
