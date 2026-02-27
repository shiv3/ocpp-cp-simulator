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
import {
  OCPPAvailability,
  OCPPStatus,
  ChargingProfilePurposeType,
  ChargingProfileKindType,
  ChargingRateUnitType,
  RecurrencyKindType,
} from "../types/OcppTypes";
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
 * Represents an active charging profile for a connector.
 * Populated by SetChargingProfile, cleared by ClearChargingProfile.
 *
 * OCPP 1.6J Smart Charging Profile Management
 * ===========================================
 *
 * SIMPLIFIED IMPLEMENTATION NOTES:
 *
 * 1. Profile Storage:
 *    - Each connector stores its own array of profiles
 *    - Profiles from connectorId=0 are duplicated to each connector (non-spec-compliant)
 *    - SPEC: Charge-point-level profiles should be stored centrally at ChargePoint level
 *
 * 2. Active Profile Selection (getActiveChargingProfile):
 *    - Returns profile with highest stackLevel among currently valid profiles
 *    - Checks validFrom/validTo for time-based validity
 *    - Does NOT implement purpose-based precedence (TxProfile > TxDefaultProfile)
 *    - SPEC: Should apply purpose precedence, then stackLevel within purpose
 *
 * 3. Recurring Profiles:
 *    - Stored as-is without calculating current period based on time elapsed
 *    - SPEC: Should calculate which period applies based on Daily/Weekly recurrence
 *
 * 4. ChargePointMaxProfile:
 *    - Treated as regular profile without enforcing station-wide total limit
 *    - SPEC: Should enforce that sum of all connector draws doesn't exceed this limit
 *
 * For production charge point implementation, see OCPP 1.6J spec section 5.10.
 */
export interface ActiveChargingProfile {
  chargingProfileId: number;
  connectorId: number;
  stackLevel: number;
  chargingProfilePurpose: ChargingProfilePurposeType;
  chargingProfileKind: ChargingProfileKindType;
  chargingRateUnit: ChargingRateUnitType;
  recurrencyKind?: RecurrencyKindType;
  validFrom?: string; // ISO 8601 timestamp
  validTo?: string; // ISO 8601 timestamp
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
  chargingProfilesChange: { profiles: ActiveChargingProfile[] };
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
  private _chargingProfiles: ActiveChargingProfile[] = [];

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

  /**
   * Get all charging profiles for this connector, sorted by stack level (highest first)
   */
  get chargingProfiles(): ActiveChargingProfile[] {
    return [...this._chargingProfiles].sort(
      (a, b) => b.stackLevel - a.stackLevel,
    );
  }

  /**
   * Get the currently active charging profile (highest valid stack level)
   * Returns null if no valid profiles exist.
   */
  getActiveChargingProfile(): ActiveChargingProfile | null {
    const now = new Date();
    const validProfiles = this._chargingProfiles.filter((profile) => {
      // Check validity period
      if (profile.validFrom && new Date(profile.validFrom) > now) {
        return false;
      }
      if (profile.validTo && new Date(profile.validTo) < now) {
        return false;
      }
      return true;
    });

    if (validProfiles.length === 0) {
      return null;
    }

    // Return profile with highest stack level
    return validProfiles.reduce((highest, current) =>
      current.stackLevel > highest.stackLevel ? current : highest,
    );
  }

  /**
   * Backwards compatibility: get the active charging profile
   * @deprecated Use getActiveChargingProfile() instead
   */
  get chargingProfile(): ActiveChargingProfile | null {
    return this.getActiveChargingProfile();
  }

  /**
   * Backwards compatibility: set a single charging profile (replaces all profiles)
   * @deprecated Use addChargingProfile() or setChargingProfiles() instead
   */
  set chargingProfile(profile: ActiveChargingProfile | null) {
    if (profile === null) {
      this.clearAllChargingProfiles();
    } else {
      this._chargingProfiles = [profile];
      this.emitProfileChanges();
    }
  }

  /**
   * Add or update a charging profile. If a profile with the same ID exists, it is replaced.
   */
  addChargingProfile(profile: ActiveChargingProfile): void {
    // Remove existing profile with same ID
    this._chargingProfiles = this._chargingProfiles.filter(
      (p) => p.chargingProfileId !== profile.chargingProfileId,
    );
    // Add new profile
    this._chargingProfiles.push(profile);
    this.emitProfileChanges();
  }

  /**
   * Remove charging profiles matching the given criteria
   * @param criteria Filter criteria (profileId, connectorId, purpose, stackLevel)
   * @returns Number of profiles removed
   */
  removeChargingProfiles(criteria: {
    profileId?: number;
    connectorId?: number;
    purpose?: ChargingProfilePurposeType;
    stackLevel?: number;
  }): number {
    const before = this._chargingProfiles.length;
    this._chargingProfiles = this._chargingProfiles.filter((profile) => {
      if (
        criteria.profileId != null &&
        profile.chargingProfileId !== criteria.profileId
      ) {
        return true; // Keep (doesn't match filter)
      }
      if (
        criteria.connectorId != null &&
        profile.connectorId !== criteria.connectorId
      ) {
        return true;
      }
      if (
        criteria.purpose != null &&
        profile.chargingProfilePurpose !== criteria.purpose
      ) {
        return true;
      }
      if (
        criteria.stackLevel != null &&
        profile.stackLevel !== criteria.stackLevel
      ) {
        return true;
      }
      return false; // Remove (matches all criteria)
    });
    const removed = before - this._chargingProfiles.length;
    if (removed > 0) {
      this.emitProfileChanges();
    }
    return removed;
  }

  /**
   * Clear all charging profiles
   */
  clearAllChargingProfiles(): void {
    if (this._chargingProfiles.length > 0) {
      this._chargingProfiles = [];
      this.emitProfileChanges();
    }
  }

  /**
   * Set all charging profiles (replaces existing profiles)
   */
  setChargingProfiles(profiles: ActiveChargingProfile[]): void {
    this._chargingProfiles = [...profiles];
    this.emitProfileChanges();
  }

  /**
   * Emit events when charging profiles change
   */
  private emitProfileChanges(): void {
    this.eventsEmitter.emit("chargingProfilesChange", {
      profiles: this.chargingProfiles,
    });
    // Also emit backwards-compatible event
    this.eventsEmitter.emit("chargingProfileChange", {
      profile: this.getActiveChargingProfile(),
    });
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
