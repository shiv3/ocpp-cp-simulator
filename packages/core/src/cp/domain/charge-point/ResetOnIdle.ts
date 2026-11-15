import type { Connector } from "../connector/Connector";
import type { ChargePoint } from "./ChargePoint";

/** What the pending-reset queue needs from its charge point. */
export interface ResetOnIdleHost {
  /** Public members go through it so spies on the charge point still see
   *  them. */
  readonly chargePoint: Pick<ChargePoint, "boot" | "resetEvse">;
  readonly connectors: () => Map<number, Connector>;
}

/**
 * The Reset OnIdle requests answered `Scheduled` (#597): they wait here
 * until the last targeted transaction ends. The charge point keeps the
 * public methods as thin delegates.
 */
export class ResetOnIdle {
  private _pending: { evseId?: number }[] = [];

  constructor(private readonly host: ResetOnIdleHost) {}

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
