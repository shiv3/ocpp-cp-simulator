import { LogType, type Logger } from "../../shared/Logger";
import type { EventEmitter } from "../../shared/EventEmitter";
import type { SimClock } from "../../shared/clock";
import { Connector } from "../connector/Connector";
import type { ChargePointEngine } from "../engine/ChargePointEngine";
import type { ConnectorWrite } from "../connector/ConnectorRecord";
import { OCPPStatus } from "../types/OcppTypes";
import type { ChargePointStatus, OCPPAvailability } from "../types/OcppTypes";
import type { ChargePointRepositories } from "../persistence/ChargePointRepositories";
import type { AuthorizationFlow } from "./AuthorizationFlow";
import type { ChargePoint } from "./ChargePoint";
import type { ChargePointEvents } from "./ChargePointEvents";
import {
  dcEfficiencyFor,
  maxDeliveryPowerWFor,
  meterRealismFor,
} from "./ChargerCapabilities";
import type {
  AutoMeterValueSetting,
  ChargePointTransportOptions,
} from "./ChargePointTypes";
import type { ChargingProfileStore } from "./ChargingProfileStore";
import type { MeterSampling } from "./MeterSampling";
import { VehicleBehaviorDriver } from "./VehicleBehaviorDriver";
import { resumeAfterEvseSuspension } from "./resumeAfterEvseSuspension";

/** What the connector wiring needs from its charge point. */
export interface ConnectorWiringHost {
  /** Public members go through it so spies on the charge point still see
   *  them. */
  readonly chargePoint: Pick<
    ChargePoint,
    | "evSetReady"
    | "clearChargingProfiles"
    | "getConnector"
    | "poweredOff"
    | "runPendingResetOnIdle"
    | "stopTransaction"
    | "updateConnectorStatus"
  >;
  readonly authorizationFlow: () => AuthorizationFlow;
  readonly clock: () => SimClock;
  readonly connectors: () => Map<number, Connector>;
  readonly engine: () => ChargePointEngine;
  readonly events: () => EventEmitter<ChargePointEvents>;
  readonly repositories: () => ChargePointRepositories;
  readonly status: () => ChargePointStatus;
  readonly logger: () => Logger;
  readonly sampling: () => MeterSampling;
  readonly stationProfiles: () => ChargingProfileStore;
  readonly vehicleDrivers: () => Map<number, VehicleBehaviorDriver>;
  readonly writeConnector: (connectorId: number, write: ConnectorWrite) => void;
}

/**
 * Creation of the station's connectors and the listeners that tie each of
 * them to the charge point (auto stop, schedule pause, periodic sampling,
 * vehicle behavior). Called once from the charge point constructor, at the
 * place the loop used to be.
 */
export class ConnectorWiring {
  constructor(private readonly host: ConnectorWiringHost) {}

  createConnectors(
    connectorCount: number,
    chargerCapabilities: ChargePointTransportOptions["chargerCapabilities"],
    autoMeterValueSetting: AutoMeterValueSetting | null,
  ): void {
    for (let connectorId = 1; connectorId <= connectorCount; connectorId++) {
      const connector = new Connector(
        connectorId,
        this.host.logger(),
        () => this.host.stationProfiles(),
        this.host.clock(),
      );
      connector.setMaxDeliveryPowerW(
        maxDeliveryPowerWFor(chargerCapabilities, connectorId),
      );
      connector.setMeterRealism(
        meterRealismFor(chargerCapabilities, connectorId),
      );
      connector.setDcEfficiency(
        dcEfficiencyFor(chargerCapabilities, connectorId),
      );
      // §5.2: Unavailable set via ChangeAvailability persists across
      // reboots. Restore the persisted value before any event listeners
      // have a chance to react.
      this.host.engine().attachConnector(connector);
      const persisted = this.loadAvailability(connectorId);
      if (persisted) {
        this.host.writeConnector(connectorId, {
          kind: "availability",
          availability: persisted,
        });
      }
      if (autoMeterValueSetting?.enabled) {
        connector.setIncrementFallback({
          intervalSeconds: autoMeterValueSetting.interval,
          incrementValue: autoMeterValueSetting.value,
        });
      }
      // When the connector signals an auto-stop (e.g. target SoC reached),
      // end the in-flight transaction the same way the user would.
      connector.events.on("autoStopRequested", ({ reason }) => {
        if (this.host.chargePoint.poweredOff) return;
        this.host
          .logger()
          .info(
            `Connector ${connectorId} auto-stop requested (${reason})`,
            LogType.TRANSACTION,
          );
        this.host.chargePoint.stopTransaction(connector, undefined, {
          triggerReason: "EnergyLimitReached",
        });
      });
      // §5.10 / §5.16: when the active schedule period switches between
      // limit=0 and a non-zero limit during a live transaction, the CP
      // should reflect that on the OCPP layer by toggling Charging ↔
      // SuspendedEVSE so the CSMS sees the pause.
      connector.events.on("scheduleLimitChange", ({ paused, watts }) => {
        if (!connector.transaction) return;
        if (paused && connector.status === OCPPStatus.Charging) {
          this.host
            .logger()
            .info(
              `Connector ${connectorId} schedule period limit=0 (W), pausing → SuspendedEVSE`,
              LogType.OCPP,
            );
          this.host.chargePoint.updateConnectorStatus(
            connectorId,
            OCPPStatus.SuspendedEVSE,
          );
        } else if (
          !paused &&
          connector.status === OCPPStatus.SuspendedEVSE &&
          !connector.energyHeld
        ) {
          this.host
            .logger()
            .info(
              `Connector ${connectorId} schedule period limit=${watts}W, resuming → Charging`,
              LogType.OCPP,
            );
          resumeAfterEvseSuspension(this.host.chargePoint, connector);
        }
      });
      // #722: MeterValueSampleInterval drives the periodic MeterValues of a
      // 1.x transaction; the interval is read when the transaction starts.
      connector.events.on("transactionChange", ({ transaction }) => {
        if (transaction && connector.hasRunningTransaction) {
          this.host.sampling().startPeriodicSampling(connector);
        } else this.host.sampling().stopPeriodicSampling(connectorId);
      });
      // A transaction restored after a daemon restart is running again and
      // gets its sampler back (the restore itself emits no transactionChange).
      connector.events.on("transactionRestored", () =>
        this.host.sampling().startPeriodicSampling(connector),
      );
      // The MaxEnergyOnInvalidId allowance ran out (E05.FR.03 → .02).
      connector.events.on("invalidIdEnergyExhausted", () => {
        this.host.authorizationFlow().reportEnergyHeld(connector);
      });
      this.host.connectors().set(connectorId, connector);
      this.host.vehicleDrivers().set(
        connectorId,
        new VehicleBehaviorDriver(
          connector,
          this.host.clock(),
          {
            setReady: (id, ready) => {
              if (this.host.chargePoint.poweredOff) return;
              if (
                this.host.chargePoint.getConnector(id)?.evConnection ===
                "disconnected"
              ) {
                return;
              }
              this.host.chargePoint.evSetReady(id, ready);
            },
            requestStop: (id) => {
              if (this.host.chargePoint.poweredOff) return;
              // Asked on every tick: once the authorization ended (E15.FR.05),
              // the transaction waits for the cable, not for another stop.
              if (connector.transaction?.authorizationEnded) return;
              this.host
                .logger()
                .info(
                  `Connector ${id} vehicle asked to end the session`,
                  LogType.TRANSACTION,
                );
              // E15.FR.04: StopAuthorized + StoppedByEV. 1.6 has no such
              // Reason (EVDisconnected is the cable leaving), so none is set.
              this.host.chargePoint.stopTransaction(connector, undefined, {
                triggerReason: "StopAuthorized",
                stoppedReason: "StoppedByEV",
              });
            },
          },
          connectorId,
        ),
      );
    }
  }

  removeConnector(connectorId: number): boolean {
    const connector = this.host.connectors().get(connectorId);
    if (!connector) return false;

    this.host.chargePoint.clearChargingProfiles(
      connectorId,
      {},
      "ConnectorRemoved",
    );
    this.host.sampling().stopPeriodicSampling(connectorId);
    // The driver's own 1 s timer outlives Connector.dispose() and would keep
    // calling evSetReady / stopTransaction on a connector the station no longer
    // has (#864 review).
    this.host.vehicleDrivers().get(connectorId)?.dispose();
    this.host.vehicleDrivers().delete(connectorId);
    connector.dispose();
    this.host.engine().detachConnector(connectorId);
    const removed = this.host.connectors().delete(connectorId);
    if (removed) {
      this.host.events().emit("connectorRemoved", { connectorId });
      // Removing a busy connector may make a station-wide OnIdle reset
      // runnable. runPendingResetOnIdle still waits if any remaining target
      // has a running transaction.
      this.host.chargePoint.runPendingResetOnIdle();
    }
    return removed;
  }

  /** Read a persisted Operative/Inoperative flag from the DB for the given
   *  connector (`0` = CP-level). Returns `null` if no override is stored. */
  loadAvailability(connectorId: number): OCPPAvailability | null {
    return this.host
      .repositories()
      .connectorSettings.loadAvailability(connectorId);
  }

  private saveAvailability(
    connectorId: number,
    availability: OCPPAvailability,
  ): void {
    this.host
      .repositories()
      .connectorSettings.saveAvailability(connectorId, availability);
  }

  /**
   * Snapshot every connector's (and the CP's) `availability` flag to the
   * configured DB so the §5.2 "Unavailable persists across reboots"
   * requirement is met. Called by ChangeAvailability after applying.
   */
  persistAvailability(): void {
    this.saveAvailability(
      0,
      this.host.status() === OCPPStatus.Unavailable
        ? "Inoperative"
        : "Operative",
    );
    this.host.connectors().forEach((connector) => {
      this.saveAvailability(connector.id, connector.availability);
    });
  }

  /** The meter-value increment the connectors fall back on when no register
   *  is fed (the `autoMeterValueSetting`). */
  applyIncrementFallback(setting: AutoMeterValueSetting | null): void {
    this.host.connectors().forEach((connector) => {
      connector.setIncrementFallback(
        setting?.enabled
          ? {
              intervalSeconds: setting.interval,
              incrementValue: setting.value,
            }
          : null,
      );
    });
  }
}
