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
  ChargePointErrorCode,
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
import { type EVSettings, getDefaultEVSettings } from "./EVSettings";
import { resolveEffectiveLimitWatts } from "./ChargingScheduleResolver";
import type { ChargingProfileStore } from "../charge-point/ChargingProfileStore";

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
  /**
   * Fires when `beginTransaction` or `stopTransaction` flips the
   * `transactionValue` field, distinct from `transactionIdChange`
   * (which only fires when the CSMS confirms a real id on an
   * already-active transaction). Persistence listeners use this to
   * catch the "transaction object just started" / "just cleared" edges
   * without needing a polling read.
   */
  transactionChange: { transaction: Transaction | null };
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
  /** Emitted when the auto-meter has reached an automatic stop condition
   *  (currently: SoC >= EVSettings.targetSoc with stopAtTargetSoc). The
   *  ChargePoint subscribes and ends the in-flight transaction. */
  autoStopRequested: { reason: "targetSocReached" };
  /** Emitted when the resolved schedule limit crosses the paused boundary
   *  (i.e. enters or leaves a limit=0 period of the active charging
   *  profile). The ChargePoint listens and flips Charging ↔ SuspendedEVSE
   *  accordingly. `watts` is the new effective cap. */
  scheduleLimitChange: { paused: boolean; watts: number };
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
  // §5.2: when ChangeAvailability arrives during an active transaction the
  // CP returns `Scheduled` and applies the new availability after the
  // transaction stops. We remember the pending value here so the
  // ChargePoint can finalize it on StopTransaction.
  private scheduledAvailabilityValue: OCPPAvailability | null = null;
  // OCPP 1.6 §7.6: ChargePointErrorCode carried in StatusNotification.req.
  // Defaults to NoError. Set this before transitioning to Faulted (or before
  // sending a warning-grade StatusNotification while
  // Preparing/SuspendedEV/SuspendedEVSE/Finishing).
  private currentErrorCodeValue: ChargePointErrorCode = "NoError";
  private currentErrorInfo: string | null = null;
  private currentVendorErrorCode: string | null = null;
  // §5.18 / §7.46: scenarios/tests can simulate broken cable retention by
  // flipping this to "UnlockFailed", or absent connector lock by setting
  // "NotSupported". UnlockConnector.req returns this value verbatim.
  private unlockResponseValue: "Unlocked" | "UnlockFailed" | "NotSupported" =
    "Unlocked";
  // When true, any meter-value update (from UI, scenario auto-increment, or
  // direct setter) also derives a SoC value from
  // `initialSoc + (delivered Wh / 1000) / capacity × 100` and applies it.
  // UI controls this via the "Sync SoC ↔ Meter" toggle. Without this in
  // the domain layer, scenario-driven meter updates would never move SoC.
  // Default ON to match the browser's default user preference. Matters for
  // remote mode (daemon) where the UI cannot push the flag down until the
  // user opens the side panel — without this default, connector cards
  // would show "—" / "SoC not reported" until the first manual interaction.
  private socMeterSyncEnabledValue = true;
  // Tracks which scenario configuration last triggered an auto-start on
  // this connector. Lives on the connector (long-lived) rather than in a
  // React useRef so opening / closing the side panel doesn't reset it and
  // re-fire the scenario from the beginning. The key encodes scenario id +
  // updatedAt + execution mode + trigger config, so saving the scenario
  // (which bumps updatedAt) will legitimately re-trigger auto-start.
  private lastAutoStartedScenarioKeyValue: string | null = null;
  private meterValueWh = 0;
  private socPercent: number | null = null;
  private transactionValue: Transaction | null = null;

  private autoConfig: AutoMeterValueConfig = { ...defaultAutoMeterValueConfig };
  private incrementFallback: IncrementStrategyConfig | null = null;
  private onMeterSend: ((connectorId: number) => void) | null = null;

  private modeValue: ScenarioMode = "manual";
  private _scenarioManager?: ScenarioManager;
  private _autoResetToAvailable = true;
  private _evSettings: EVSettings = getDefaultEVSettings();
  private _chargingProfiles: ActiveChargingProfile[] = [];

  /**
   * Capture the runtime state needed to resume this connector after a
   * daemon restart. Paired with {@link restoreRuntimeSnapshot}. The
   * returned shape is a structural copy: callers can persist it and
   * round-trip it through JSON without aliasing live connector state.
   */
  snapshotRuntime(): {
    status: OCPPStatus;
    availability: OCPPAvailability;
    scheduledAvailability: OCPPAvailability | null;
    transaction: Transaction | null;
    meterValueWh: number;
    socPercent: number | null;
    lastAutoStartedScenarioKey: string | null;
  } {
    return {
      status: this.statusValue,
      availability: this.availabilityValue,
      scheduledAvailability: this.scheduledAvailabilityValue,
      transaction: this.transactionValue ? { ...this.transactionValue } : null,
      meterValueWh: this.meterValueWh,
      socPercent: this.socPercent,
      lastAutoStartedScenarioKey: this.lastAutoStartedScenarioKeyValue,
    };
  }

  /**
   * Apply a snapshot captured before a daemon restart. Writes the
   * private fields directly so we do NOT emit `statusChange` /
   * `meterChange` / etc. — emitting on restore would cause the
   * ChargePoint to push a duplicate StatusNotification or MeterValues
   * before the WebSocket is even up, and would cause the auto-start
   * dedup key to be cleared by re-triggering its setter.
   *
   * Restore is idempotent on already-default values: nulls and
   * `meterValueWh = 0` simply rewrite the existing zero state.
   */
  restoreRuntimeSnapshot(snapshot: {
    status: OCPPStatus;
    availability: OCPPAvailability;
    scheduledAvailability: OCPPAvailability | null;
    transaction: Transaction | null;
    meterValueWh: number;
    socPercent: number | null;
    lastAutoStartedScenarioKey: string | null;
  }): void {
    this.statusValue = snapshot.status;
    this.availabilityValue = snapshot.availability;
    this.scheduledAvailabilityValue = snapshot.scheduledAvailability;
    this.transactionValue = snapshot.transaction
      ? { ...snapshot.transaction }
      : null;
    this.meterValueWh = snapshot.meterValueWh;
    this.socPercent = snapshot.socPercent;
    this.lastAutoStartedScenarioKeyValue = snapshot.lastAutoStartedScenarioKey;
  }

  /**
   * Lazy getter for the parent ChargePoint's `ChargingProfileStore`. We
   * take a closure rather than a direct reference because the connector
   * is constructed inside the ChargePoint's loop, and the store is a
   * `this`-owned field that would force a temporal-dead-zone dance if
   * we passed it eagerly. The closure is also nullable for the benefit
   * of tests that construct a bare Connector without a ChargePoint —
   * those just see an empty station store.
   */
  private readonly stationProfilesProvider: () => ChargingProfileStore | null;

  constructor(
    private readonly connectorId: number,
    private readonly logger: Logger,
    stationProfilesProvider?: () => ChargingProfileStore | null,
  ) {
    this.stationProfilesProvider = stationProfilesProvider ?? (() => null);
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
        // Re-evaluated every tick so a schedule that crosses a period
        // boundary mid-transaction is honored immediately.
        getScheduleLimitWatts: () => this.currentScheduleLimitWatts(),
      },
      this.logger,
    );
  }

  /**
   * Resolve the effective wattage cap from the active charging profile (if
   * any) at the current instant, anchored to the in-flight transaction's
   * start time. Returns `Infinity` when uncapped — i.e. no profile, or no
   * transaction context to anchor a Relative schedule on.
   *
   * Side-effect: if the paused/active state flipped since the last call,
   * emits `scheduleLimitChange` so the ChargePoint can move the connector
   * between Charging and SuspendedEVSE. Mid-tick crossings of a period
   * boundary inside a Recurring or Absolute profile are picked up this way
   * without needing an extra timer.
   */
  currentScheduleLimitWatts(): number {
    const txProfile = this.getActiveChargingProfile();
    const stationMax =
      this.stationProfilesProvider()?.getActive(
        ChargingProfilePurposeType.ChargePointMaxProfile,
      ) ?? null;
    const start = this.transactionValue?.startTime ?? null;
    const resolved = resolveEffectiveLimitWatts(txProfile, stationMax, start);
    const paused = resolved.watts === 0;
    const isCapped = resolved.watts !== Infinity;
    if (
      isCapped &&
      (this.lastSchedulePaused === null || paused !== this.lastSchedulePaused)
    ) {
      this.lastSchedulePaused = paused;
      this.eventsEmitter.emit("scheduleLimitChange", {
        paused,
        watts: resolved.watts,
      });
    } else if (!isCapped && this.lastSchedulePaused !== null) {
      // Profile cleared — reset so we re-arm on the next SetChargingProfile.
      this.lastSchedulePaused = null;
    }
    return resolved.watts;
  }

  /** Snapshot of the last resolved "paused" state, used to detect crossings
   *  of the limit=0 boundary across schedule periods. `null` means we
   *  haven't seen a capped schedule yet (or it was cleared). */
  private lastSchedulePaused: boolean | null = null;

  private socFromMeterValue(meterValueWh: number): number | null {
    const transactionCapacity = this.transactionValue?.batteryCapacityKwh;
    const capacity =
      transactionCapacity && transactionCapacity > 0
        ? transactionCapacity
        : this._evSettings.batteryCapacityKwh;
    if (capacity <= 0) return null;

    const initial =
      this.transactionValue?.initialSoc ?? this._evSettings.initialSoc ?? 0;
    const meterStart = this.transactionValue?.meterStart ?? 0;
    const deliveredKWh = Math.max(0, meterValueWh - meterStart) / 1000;
    const derived = initial + (deliveredKWh / capacity) * 100;
    return Math.min(100, Math.max(0, derived));
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

  /** Pending availability that should be applied once the in-flight
   *  transaction ends (set by ChangeAvailability while charging). */
  get scheduledAvailability(): OCPPAvailability | null {
    return this.scheduledAvailabilityValue;
  }

  set scheduledAvailability(value: OCPPAvailability | null) {
    this.scheduledAvailabilityValue = value;
  }

  get currentErrorCode(): ChargePointErrorCode {
    return this.currentErrorCodeValue;
  }

  set currentErrorCode(code: ChargePointErrorCode) {
    this.currentErrorCodeValue = code;
  }

  get errorInfo(): string | null {
    return this.currentErrorInfo;
  }

  set errorInfo(info: string | null) {
    this.currentErrorInfo = info;
  }

  get vendorErrorCode(): string | null {
    return this.currentVendorErrorCode;
  }

  set vendorErrorCode(code: string | null) {
    this.currentVendorErrorCode = code;
  }

  get unlockResponse(): "Unlocked" | "UnlockFailed" | "NotSupported" {
    return this.unlockResponseValue;
  }

  set unlockResponse(value: "Unlocked" | "UnlockFailed" | "NotSupported") {
    this.unlockResponseValue = value;
  }

  get socMeterSyncEnabled(): boolean {
    return this.socMeterSyncEnabledValue;
  }

  set socMeterSyncEnabled(value: boolean) {
    const wasOff = !this.socMeterSyncEnabledValue;
    this.socMeterSyncEnabledValue = value;
    // Flipping ON mid-session should immediately reflect any meter value
    // that's already accumulated, so the UI doesn't sit on "SoC not
    // reported" until the next meter tick. Keep the existing socPercent if
    // an explicit value (MeterValue SoC sample, manual override) was set —
    // we only derive from the meter when nothing else has populated it.
    if (value && wasOff) {
      const derived = this.socFromMeterValue(this.meterValueWh);
      if (derived !== null && this.socPercent !== derived) {
        this.socPercent = derived;
        this.eventsEmitter.emit("socChange", { soc: derived });
      }
    }
  }

  get lastAutoStartedScenarioKey(): string | null {
    return this.lastAutoStartedScenarioKeyValue;
  }

  set lastAutoStartedScenarioKey(value: string | null) {
    this.lastAutoStartedScenarioKeyValue = value;
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
    this.checkAutoStop();
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
   * Resolve the connector's currently active **Tx-layer** charging profile
   * per OCPP 1.6 §3.13.3 precedence rules:
   *
   *   1. The connector's own TxProfile (highest valid stackLevel) — if
   *      one exists it completely overrules anything else at the Tx layer.
   *   2. Otherwise, the highest valid TxDefaultProfile among:
   *        - this connector's own TxDefaultProfile(s), and
   *        - the station-wide TxDefaultProfile(s) (installed by the CSMS
   *          via SetChargingProfile.req with connectorId=0).
   *
   * The ChargePointMaxProfile lives separately on the ChargePoint and is
   * combined with this result via `min` inside the resolver.
   *
   * Returns `null` when no Tx-layer profile applies.
   */
  getActiveChargingProfile(
    now: Date = new Date(),
  ): ActiveChargingProfile | null {
    const isValid = (profile: ActiveChargingProfile) => {
      if (profile.validFrom && new Date(profile.validFrom) > now) return false;
      if (profile.validTo && new Date(profile.validTo) < now) return false;
      return true;
    };

    // Tier 1: TxProfile on this connector wins outright (§3.13.3).
    const txProfiles = this._chargingProfiles.filter(
      (p) =>
        p.chargingProfilePurpose === ChargingProfilePurposeType.TxProfile &&
        isValid(p),
    );
    if (txProfiles.length > 0) {
      return txProfiles.reduce((best, c) =>
        c.stackLevel > best.stackLevel ? c : best,
      );
    }

    // Tier 2: TxDefaultProfile — connector-own and station-wide compete
    // by stackLevel. (If a CSMS wants connector defaults to always win
    // over station defaults, it sets them at a higher stackLevel.)
    const ownDefaults = this._chargingProfiles.filter(
      (p) =>
        p.chargingProfilePurpose ===
          ChargingProfilePurposeType.TxDefaultProfile && isValid(p),
    );
    const stationDefaults =
      this.stationProfilesProvider()
        ?.all()
        .filter(
          (p) =>
            p.chargingProfilePurpose ===
              ChargingProfilePurposeType.TxDefaultProfile && isValid(p),
        ) ?? [];
    const defaults = [...ownDefaults, ...stationDefaults];
    if (defaults.length === 0) return null;
    return defaults.reduce((best, c) =>
      c.stackLevel > best.stackLevel ? c : best,
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
    this.eventsEmitter.emit("transactionChange", { transaction });
  }

  stopTransaction(): void {
    this.meterScheduler.stop();
    this.transactionValue = null;
    this.eventsEmitter.emit("transactionChange", { transaction: null });
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
  }

  dispose(): void {
    this.cleanup();
    if (this._scenarioManager) {
      this._scenarioManager.destroy();
      this._scenarioManager = undefined;
    }
    this.eventsEmitter.removeAllListeners();
    this.scenarioEventsEmitter.removeAllListeners();
    this.onMeterSend = null;
    // Intentionally do NOT clear `transactionValue` / `socPercent` in either
    // runtime cleanup or full dispose. Disconnect/reconnect paths rely on those
    // values so post-boot StatusNotifications can describe the live connector
    // state instead of orphaning an in-flight transaction at the CSMS side.
  }

  private applyMeterValue(value: number): void {
    // OCPP 1.6 register meter values — StartTransaction.meterStart,
    // StopTransaction.meterStop and MeterValues sampled values for
    // Energy.Active.Import.Register — are integer watt-hours. The auto-meter
    // curve interpolates in kWh and can yield a fractional Wh, so round to an
    // integer here. A fractional meterStop is rejected by a strict CSMS with a
    // FormationViolation ("cannot unmarshal number … into … of type int"),
    // which silently strands the transaction in "Charging".
    const meterValueWh = Math.round(value);
    this.meterValueWh = meterValueWh;
    this.eventsEmitter.emit("meterValueChange", { meterValue: meterValueWh });
    // Mirror the new meter value into SoC when the UI has flipped Sync on.
    // We do it here (not just in UI handlers) so the scenario's auto-meter
    // scheduler and any other domain caller also drive SoC. capacity=0 means
    // we have no way to convert — leave SoC untouched in that case.
    if (this.socMeterSyncEnabledValue) {
      const derived = this.socFromMeterValue(meterValueWh);
      if (derived !== null && this.socPercent !== derived) {
        this.socPercent = derived;
        this.eventsEmitter.emit("socChange", { soc: derived });
      }
    }
    this.checkAutoStop();
  }

  /**
   * Effective SoC used for the auto-stop check. Prefers the explicit
   * `socPercent` (manual override, or values reported via MeterValue
   * SoC samples) and falls back to the value implied by the meter
   * (initialSoc + deliveredKWh / capacityKWh × 100).
   */
  private effectiveSocPercent(): number | null {
    if (this.socPercent !== null) return this.socPercent;
    return this.socFromMeterValue(this.meterValueWh);
  }

  /**
   * If `stopAtTargetSoc` is enabled and the connector has hit its target,
   * stop the in-flight meter scheduler and fire `autoStopRequested` so
   * the ChargePoint can end the transaction.
   */
  private checkAutoStop(): void {
    if (!this.autoConfig.stopAtTargetSoc) return;
    if (!this.transactionValue) return;
    if (!this.meterScheduler.isActive()) return;
    const current = this.effectiveSocPercent();
    if (current === null) return;
    if (current < this._evSettings.targetSoc) return;
    this.meterScheduler.stop();
    this.eventsEmitter.emit("autoStopRequested", {
      reason: "targetSocReached",
    });
  }
}
