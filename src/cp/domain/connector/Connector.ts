import { EventEmitter } from "../../shared/EventEmitter";
import type { Logger } from "../../shared/Logger";
import {
  type AutoMeterValueConfig,
  defaultAutoMeterValueConfig,
} from "./MeterValueCurve";
import {
  MeterValueScheduler,
  type MeterValueStrategy,
} from "./MeterValueScheduler";
import { OCPPAvailability, OCPPStatus } from "../types/OcppTypes";
import type { ScenarioManager } from "../../application/scenario/ScenarioManager";
import {
  ScenarioMode,
  ScenarioEvents,
} from "../../application/scenario/ScenarioTypes";
import { Transaction } from "./Transaction";
import { type EVSettings, defaultEVSettings } from "./EVSettings";

export interface ChargingSchedulePeriod {
  startPeriod: number;
  limit: number;
  numberPhases?: number;
}

/**
 * Represents the most recently received charging profile for a connector.
 * Populated by SetChargingProfile, cleared by ClearChargingProfile.
 */
export interface ActiveChargingProfile {
  chargingProfileId: number;
  connectorId: number;
  stackLevel: number;
  chargingProfilePurpose: string;
  chargingProfileKind: string;
  chargingRateUnit: string;
  chargingSchedulePeriods: ChargingSchedulePeriod[];
}

export interface ConnectorEvents {
  statusChange: { status: OCPPStatus; previousStatus: OCPPStatus };
  transactionIdChange: { transactionId: number | null };
  meterValueChange: { meterValue: number };
  socChange: { soc: number | null };
  availabilityChange: { availability: OCPPAvailability };
  autoMeterValueChange: { config: AutoMeterValueConfig };
  modeChange: { mode: ScenarioMode };
  autoResetToAvailableChange: { enabled: boolean };
  evSettingsChange: { settings: EVSettings };
  chargingProfileChange: { profile: ActiveChargingProfile | null };
}

interface IncrementStrategyConfig {
  intervalSeconds: number;
  incrementValue: number;
}

/**
 * Connector aggregates charging behaviour and owns its meter automation.
 */
export class Connector {
  private readonly eventsEmitter = new EventEmitter<ConnectorEvents>();
  private readonly scenarioEventsEmitter = new EventEmitter<ScenarioEvents>();
  private readonly meterScheduler: MeterValueScheduler;

  private statusValue: OCPPStatus = OCPPStatus.Unavailable;
  private availabilityValue: OCPPAvailability = "Operative";
  private meterValueWh = 0;
  private socPercent: number | null = null;
  private transactionValue: Transaction | null = null;

  private autoConfig: AutoMeterValueConfig = { ...defaultAutoMeterValueConfig };
  private incrementFallback: IncrementStrategyConfig | null = null;
  private onMeterSend: ((connectorId: number) => void) | null = null;

  private modeValue: ScenarioMode = "manual";
  private _scenarioManager?: ScenarioManager;
  private _autoResetToAvailable = true;
  private _evSettings: EVSettings = { ...defaultEVSettings };
  private _chargingProfile: ActiveChargingProfile | null = null;

  constructor(
    private readonly connectorId: number,
    private readonly logger: Logger,
  ) {
    this.meterScheduler = new MeterValueScheduler(
      connectorId,
      {
        getCurrentValue: () => this.meterValueWh,
        updateValue: (value) => this.applyMeterValue(value),
        onSend: (id) => {
          if (this.onMeterSend) {
            this.onMeterSend(id);
          }
        },
      },
      this.logger,
    );
  }

  get id(): number {
    return this.connectorId;
  }

  get events(): EventEmitter<ConnectorEvents> {
    return this.eventsEmitter;
  }

  get scenarioEvents(): EventEmitter<ScenarioEvents> {
    return this.scenarioEventsEmitter;
  }

  get status(): OCPPStatus {
    return this.statusValue;
  }

  set status(newStatus: OCPPStatus) {
    const previousStatus = this.statusValue;
    this.statusValue = newStatus;
    this.eventsEmitter.emit("statusChange", {
      status: newStatus,
      previousStatus,
    });
  }

  get availability(): OCPPAvailability {
    return this.availabilityValue;
  }

  set availability(newAvailability: OCPPAvailability) {
    this.availabilityValue = newAvailability;
    this.eventsEmitter.emit("availabilityChange", {
      availability: newAvailability,
    });
  }

  get meterValue(): number {
    return this.meterValueWh;
  }

  set meterValue(value: number) {
    this.applyMeterValue(value);
  }

  get soc(): number | null {
    return this.socPercent;
  }

  set soc(value: number | null) {
    this.socPercent = value;
    this.eventsEmitter.emit("socChange", { soc: value });
  }

  get transaction(): Transaction | null {
    return this.transactionValue;
  }

  set transaction(transaction: Transaction | null) {
    this.transactionValue = transaction;
  }

  set transactionId(transactionId: number | null) {
    if (!this.transactionValue) return;
    this.transactionValue.id = transactionId;
    this.eventsEmitter.emit("transactionIdChange", { transactionId });
  }

  get mode(): ScenarioMode {
    return this.modeValue;
  }

  set mode(newMode: ScenarioMode) {
    this.modeValue = newMode;
    this.eventsEmitter.emit("modeChange", { mode: newMode });
  }

  get autoResetToAvailable(): boolean {
    return this._autoResetToAvailable;
  }

  set autoResetToAvailable(enabled: boolean) {
    this._autoResetToAvailable = enabled;
    this.eventsEmitter.emit("autoResetToAvailableChange", { enabled });
  }

  get evSettings(): EVSettings {
    return this._evSettings;
  }

  set evSettings(settings: EVSettings) {
    this._evSettings = { ...settings };
    this.eventsEmitter.emit("evSettingsChange", { settings: this._evSettings });
  }

  get chargingProfile(): ActiveChargingProfile | null {
    return this._chargingProfile;
  }

  set chargingProfile(profile: ActiveChargingProfile | null) {
    this._chargingProfile = profile;
    this.eventsEmitter.emit("chargingProfileChange", { profile });
  }

  get autoMeterValueConfig(): AutoMeterValueConfig {
    return this.autoConfig;
  }

  set autoMeterValueConfig(config: AutoMeterValueConfig) {
    this.autoConfig = config;
    this.eventsEmitter.emit("autoMeterValueChange", { config });

    if (this.transactionValue) {
      this.startConfiguredMeterValue();
    }
  }

  setIncrementFallback(config: IncrementStrategyConfig | null): void {
    this.incrementFallback = config;
    if (this.transactionValue && !this.autoConfig.enabled) {
      this.startConfiguredMeterValue();
    }
  }

  setOnMeterValueSend(callback: (connectorId: number) => void): void {
    this.onMeterSend = callback;
  }

  beginTransaction(transaction: Transaction): void {
    this.transactionValue = transaction;
    this.startConfiguredMeterValue();
  }

  stopTransaction(): void {
    this.meterScheduler.stop();
    this.transactionValue = null;
  }

  startManualMeterStrategy(strategy: MeterValueStrategy): void {
    this.meterScheduler.start(strategy);
  }

  startConfiguredMeterValue(): void {
    if (!this.transactionValue) return;

    if (this.autoConfig.enabled) {
      this.meterScheduler.start({ kind: "curve", config: this.autoConfig });
      return;
    }

    if (
      this.incrementFallback &&
      this.incrementFallback.incrementValue > 0 &&
      this.incrementFallback.intervalSeconds > 0
    ) {
      this.meterScheduler.start({
        kind: "increment",
        intervalSeconds: this.incrementFallback.intervalSeconds,
        incrementValue: this.incrementFallback.incrementValue,
      });
      return;
    }

    this.meterScheduler.stop();
  }

  stopAutoMeterValue(): void {
    this.meterScheduler.stop();
  }

  isAutoMeterValueActive(): boolean {
    return this.meterScheduler.isActive();
  }

  setScenarioManager(manager: ScenarioManager): void {
    if (this._scenarioManager) {
      this._scenarioManager.destroy();
    }
    this._scenarioManager = manager;
  }

  get scenarioManager(): ScenarioManager | undefined {
    return this._scenarioManager;
  }

  cleanup(): void {
    this.meterScheduler.cleanup();
    if (this._scenarioManager) {
      this._scenarioManager.destroy();
      this._scenarioManager = undefined;
    }
    this.eventsEmitter.removeAllListeners();
    this.onMeterSend = null;
    this.transactionValue = null;
    this.socPercent = null;
  }

  private applyMeterValue(value: number): void {
    this.meterValueWh = value;
    this.eventsEmitter.emit("meterValueChange", { meterValue: value });
  }
}
