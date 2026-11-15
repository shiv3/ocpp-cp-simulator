import {
  evaluateVehicleBehavior,
  startVehicleSession,
} from "@ocpp-cp-simulator/vehicle/evaluate";
import type {
  VehicleBehaviorSpec,
  VehicleSnapshot,
} from "@ocpp-cp-simulator/vehicle/contracts";
import { resolveVehicleBehaviorConfig } from "@ocpp-cp-simulator/vehicle/config";
import type { Transaction } from "./Transaction";
import type { EVSettings } from "./EVSettings";
import type { SessionIntent } from "./SessionIntent";

/** What the vehicle-behavior view needs from the connector that owns it. */
export interface ConnectorVehicleHost {
  now(): number;
  evCableConnected(): boolean;
  vehicleConnectedAt(): number | null;
  setVehicleConnectedAt(value: number | null): void;
  evSettings(): EVSettings;
  sessionIntent(): SessionIntent;
  transaction(): Transaction | null;
  hasRunningTransaction(): boolean;
  meterValueWh(): number;
  effectiveSocPercent(): number | null;
}

/**
 * The vehicle behavior of a connector: its snapshot and the demand term of the
 * operating point (#835). Moved verbatim out of `Connector` (#877); the fields
 * stay on the connector and are reached through the host.
 */
export class ConnectorVehicle {
  constructor(private readonly host: ConnectorVehicleHost) {}

  /** The behavior the vehicle follows, resolved from its EV settings
   *  (`vehicleBehavior`), `null` when none is set (#835). */
  get vehicleBehavior(): VehicleBehaviorSpec | null {
    return resolveVehicleBehaviorConfig(this.host.evSettings().vehicleBehavior);
  }

  /** Stamp the instant the vehicle connected, if a cable is on and nothing
   *  was stamped yet: a vehicle that was there before its behavior was set
   *  keeps its plug-in time (#835). */
  ensureVehicleSession(): void {
    if (
      this.host.evCableConnected() &&
      this.host.vehicleConnectedAt() === null
    ) {
      this.host.setVehicleConnectedAt(this.host.now());
    }
  }

  /**
   * What the vehicle wants now, separately from what the connector delivers
   * (#835): its phase, its demand and the state of its objective. `null`
   * without a behavior or a cable. Pure: the same connector state at the same
   * instant gives the same snapshot.
   */
  vehicleSnapshot(): VehicleSnapshot | null {
    return this.vehicleSnapshotAt(this.host.now());
  }

  private vehicleSnapshotAt(now: number): VehicleSnapshot | null {
    const spec = this.vehicleBehavior;
    if (!spec || !this.host.evCableConnected()) return null;
    const intent = this.host.sessionIntent();
    const settings = this.host.evSettings();
    const transaction = this.host.transaction();
    const delivered =
      transaction && this.host.hasRunningTransaction()
        ? Math.max(0, this.host.meterValueWh() - (transaction.meterStart ?? 0))
        : 0;
    return evaluateVehicleBehavior(
      {
        ...spec,
        intent: {
          ...(intent.targetSoc !== undefined && {
            targetSoc: intent.targetSoc,
          }),
          ...(intent.requestedWh !== undefined && {
            requestedEnergyWh: intent.requestedWh,
          }),
          ...(intent.departureAt !== undefined && {
            departureAt: intent.departureAt,
          }),
          ...spec.intent,
        },
      },
      {
        ...(settings.maxChargingPowerKw > 0 && {
          maxPowerW: settings.maxChargingPowerKw * 1000,
        }),
        ...(settings.batteryCapacityKwh > 0 && {
          batteryCapacityWh: settings.batteryCapacityKwh * 1000,
        }),
      },
      startVehicleSession(this.host.vehicleConnectedAt() ?? now),
      { soc: this.host.effectiveSocPercent(), deliveredWh: delivered },
      now,
    );
  }

  /** The demand term of the resolution: absent without a behavior (the
   *  vehicle asks for all it can take), else what the vehicle asks for now. */
  vehicleDemandTerm(now: number): { requestedW: number } | undefined {
    const snapshot = this.vehicleSnapshotAt(now);
    if (!snapshot) return undefined;
    return {
      requestedW: snapshot.demand.readyToCharge
        ? snapshot.demand.requestedPowerW
        : 0,
    };
  }
}
