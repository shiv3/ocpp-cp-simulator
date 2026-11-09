import type { Connector } from "../connector/Connector";
import type { SimClock, TimerHandle } from "../../shared/clock";

/** How often a connector's vehicle behavior is looked at (ms). */
export const VEHICLE_BEHAVIOR_TICK_MS = 1000;

/** What the driver asks the station to do; the station owns every protocol
 *  effect (#453 readiness operations, the transaction stop). */
export interface VehicleBehaviorPorts {
  /** `ChargePoint.evSetReady`: idempotent, throws without a cable. */
  setReady(connectorId: number, ready: boolean): void;
  /** End the running transaction because the vehicle asked to. */
  requestStop(connectorId: number): void;
}

/**
 * Applies a connector's vehicle behavior (#835) to the station: while the
 * connector's EV settings carry a `vehicleBehavior`, it reads the vehicle's
 * demand once a second and on every transaction change and calls the existing
 * readiness operation, so a vehicle that pauses or finishes shows up as
 * `SuspendedEV` (1.6 §4.9, 2.x `chargingState` `SuspendedEV`) through the one
 * code path a manual `evSetReady` takes. Its power request needs no driver:
 * the connector puts it into the operating point at every resolve.
 *
 * No timer runs for a connector without a behavior.
 */
export class VehicleBehaviorDriver {
  private timer: TimerHandle | null = null;
  private readonly off: Array<() => void> = [];

  constructor(
    private readonly connector: Connector,
    private readonly clock: SimClock,
    private readonly ports: VehicleBehaviorPorts,
    private readonly connectorId: number,
  ) {
    // Never inside the event: a station writes its status after emitting
    // `statusChange`, so a write made from the listener would reach the wire
    // before the change that caused it.
    const resync = () => this.schedule();
    this.off.push(
      connector.events.on("evSettingsChange", resync),
      connector.events.on("transactionChange", resync),
      connector.events.on("statusChange", resync),
    );
    this.sync();
  }

  private pending: TimerHandle | null = null;

  /** Apply the vehicle's demand once, as soon as the current event is over. */
  private schedule(): void {
    if (this.pending !== null) return;
    this.pending = this.clock.setTimeout(() => {
      this.pending = null;
      this.sync();
    }, 0);
  }

  /** Start or stop the timer to match whether a behavior is set, then apply
   *  the vehicle's demand once. */
  sync(): void {
    const active = this.connector.vehicleBehavior !== null;
    if (active && this.timer === null) {
      this.timer = this.clock.setInterval(
        () => this.apply(),
        VEHICLE_BEHAVIOR_TICK_MS,
      );
    } else if (!active && this.timer !== null) {
      this.clock.clearInterval(this.timer);
      this.timer = null;
    }
    if (active) this.apply();
  }

  /** Tracks the connector's state; `sync` is for a caller outside an event. */

  private applying = false;

  private apply(): void {
    // A status change caused by this very call re-enters through the listener.
    if (this.applying) return;
    this.applying = true;
    try {
      this.connector.ensureVehicleSession();
      const snapshot = this.connector.vehicleSnapshot();
      if (!snapshot) return;
      this.ports.setReady(this.connectorId, snapshot.demand.readyToCharge);
      if (
        snapshot.demand.stopRequested &&
        this.connector.hasRunningTransaction
      ) {
        this.ports.requestStop(this.connectorId);
      }
    } finally {
      this.applying = false;
    }
  }

  dispose(): void {
    if (this.pending !== null) this.clock.clearTimeout(this.pending);
    this.pending = null;
    if (this.timer !== null) this.clock.clearInterval(this.timer);
    this.timer = null;
    for (const off of this.off) off();
    this.off.length = 0;
  }
}
