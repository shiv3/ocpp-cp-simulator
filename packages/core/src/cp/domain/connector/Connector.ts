import { EventEmitter } from "../../shared/EventEmitter";
import type { Logger } from "../../shared/Logger";
import { realClock } from "../../shared/clock";
import type { SimClock } from "../../shared/clock";
import {
  type AutoMeterValueConfig,
  defaultAutoMeterValueConfig,
  withNormalizedCurvePoints,
} from "./MeterValueCurve";
import {
  MeterValueScheduler,
  type MeterValueStrategy,
} from "./MeterValueScheduler";
import type {
  ChargePointErrorCode,
  OCPPAvailability,
} from "../types/OcppTypes";
import { OCPPStatus } from "../types/OcppTypes";
import type { ScenarioMode } from "@ocpp-cp-simulator/contracts/scenario";
import type { Transaction } from "./Transaction";
import {
  applyPatchToTransaction,
  patchOfFields,
  recordOfTransaction,
  transactionOfRecord,
  type TransactionRecord,
} from "./TransactionRecord";
import {
  initialConnectorRecord,
  reduceConnectorRecord,
  type ConnectorRecord,
  type ConnectorStateStore,
  type ConnectorWrite,
} from "./ConnectorRecord";
import {
  type EVSettings,
  type EVSettingsPatch,
  assertRequiredFieldsKept,
  defaultEVSettings,
  getDefaultEVSettings,
  withoutNulls,
} from "./EVSettings";
import { withNormalizedChargingCurve } from "./ChargingCurve";
import {
  resolveOperatingPoint,
  chargerTermOf,
  conversionEfficiencyOf,
  vehicleTermOf,
  type OperatingPoint,
} from "./OperatingPoint";
import { evConnectionOf, type EvConnectionState } from "./EvConnection";
import type {
  VehicleBehaviorSpec,
  VehicleSnapshot,
} from "@ocpp-cp-simulator/vehicle/contracts";
import type { MeterRealism } from "./MeterRealism";
import { resolveSessionIntent, type SessionIntent } from "./SessionIntent";
import { ScheduleLimiter } from "./ScheduleLimiter";
import { ConnectorChargingProfiles } from "./ConnectorChargingProfiles";
import { ConnectorEnergy } from "./ConnectorEnergy";
import { ConnectorVehicle } from "./ConnectorVehicle";
import { ConnectorRuntimeSnapshot } from "./connectorRuntimeSnapshot";
import {
  type ApplyChargingProfileOptions,
  type ChargingProfileStore,
  type ProfileRemoveCriteria,
} from "../charge-point/ChargingProfileStore";

export type {
  ChargingSchedulePeriod,
  ActiveChargingProfile,
  ConnectorEvents,
} from "./ConnectorEvents";
import type { ActiveChargingProfile, ConnectorEvents } from "./ConnectorEvents";

interface IncrementStrategyConfig {
  intervalSeconds: number;
  incrementValue: number;
}

/**
 * Connector aggregates charging behaviour and owns its meter automation.
 */
export class Connector {
  private readonly eventsEmitter = new EventEmitter<ConnectorEvents>();
  private readonly meterScheduler: MeterValueScheduler;

  // Status, availability (§5.2: a ChangeAvailability during a transaction is
  // answered `Scheduled` and applied when it stops) and the error fields of
  // the next StatusNotification (OCPP 1.6 §7.6; NoError by default, set before
  // moving to Faulted) are a ConnectorRecord. Inside a charge point the record
  // lives in the charger engine's state and every write is an engine event;
  // on its own a connector keeps it in `localRecord`.
  private localRecord: ConnectorRecord = initialConnectorRecord();
  private store: ConnectorStateStore = this.createLocalStore();
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

  /**
   * Whether the current `socPercent` is waiting for the transaction that
   * starts next, rather than describing one that has already run.
   *
   * `stopTransaction` deliberately leaves `socPercent` in place — the
   * disconnect/reconnect paths and post-boot StatusNotifications describe the
   * connector with it — so at the moment a new transaction begins the value on
   * the connector may belong to the car that just left. The charging curve is
   * evaluated against it from the first scheduler interval, the interval that
   * sets the session's opening power, and with meter/SoC sync off nothing
   * would ever correct it (#301).
   *
   * Exactly one bit decides that, and it is set at the one place every SoC
   * write passes through, by asking whether a transaction was running at the
   * moment of the write:
   *
   * - Written while the connector was **idle** — typed into the side panel
   *   before pressing Start, or handed to `startTransaction` as `initialSoc`,
   *   which `ChargePoint` writes through the `soc` setter just before
   *   `beginTransaction` — it is a statement about the car plugged in now, and
   *   waits. `beginTransaction` keeps it and **claims** it, clearing the bit so
   *   it cannot be claimed twice.
   * - Written while a **session was running**, or derived from the energy
   *   register, it describes that session's car. Once that session ends it is
   *   a leftover, and `beginTransaction` replaces it with
   *   `transaction.initialSoc ?? evSettings.initialSoc`.
   *
   * One bit, not three states: how the value arrived — meter or human — turned
   * out never to change what happens to it, and a three-state model that only
   * two states of collapsed cleanly onto the disk let a session-owned SoC come
   * back from a restart looking like a pending one.
   */
  private socAwaitsNextTransaction = true;
  private socPercent: number | null = null;
  // The transaction is part of the connector's record (engine state). Code
  // gets a live `Transaction` object, a view: reads are plain property reads,
  // an assignment to one of its fields dispatches a `transaction.patch` write.
  // `applyWrite` keeps it in step with the record, so its identity lasts as
  // long as the transaction does.
  private txView: Transaction | null = null;
  private txTarget: Transaction | null = null;

  /**
   * The EV side of the cable was unplugged during a transaction the station
   * keeps (`StopTransactionOnEVSideDisconnect=false`, 2.0.1 E10: the energy
   * offer stops, the transaction does not) (#488). While set, the meter cap is
   * zero: the scheduler keeps ticking, so periodic MeterValues still go out,
   * but the energy register does not rise. Cleared when the connector leaves
   * `SuspendedEV` and when a transaction begins. Not persisted.
   */
  private energyOfferSuspendedValue = false;

  /**
   * The physical EV and cable side of the connector (#453): is a cable
   * plugged in, and is the EV asking for energy. Orthogonal to the OCPP
   * status, which the engine's record owns: this is what the status
   * reacts to, not a second state machine. In memory only; a transaction
   * that attaches (also a restored one) implies a plugged-in, ready EV.
   */
  private evCableConnected = false;
  private evReadyValue = true;

  /**
   * The CSMS did not accept the id of the running transaction and
   * `StopTransactionOnInvalidId` is false: the station keeps the transaction
   * but stops the energy delivery (2.0.1 E05.FR.02; 2.x only, 1.6 errata 3.17
   * is #736). While
   * held, the meter cap is zero and the energy register does not rise; the
   * scheduler keeps ticking. Unlike {@link energyOfferSuspendedValue} it
   * survives status changes (SuspendedEVSE). Cleared when a transaction
   * begins. Not persisted.
   */
  private energyHeldForInvalidId = false;
  /** Register value (Wh) at which the hold starts, from
   *  `MaxEnergyOnInvalidId` > 0; null when no allowance is running. */
  private invalidIdHoldAtWh: number | null = null;

  private autoConfig: AutoMeterValueConfig = { ...defaultAutoMeterValueConfig };
  private incrementFallback: IncrementStrategyConfig | null = null;
  private onMeterSend: ((connectorId: number) => void) | null = null;
  /** #722: the ChargePoint sends the periodic MeterValues of this
   *  connector's transaction (`MeterValueSampleInterval`). */
  private stationOwnsMeterSampling = false;
  /** #722: the running meter strategy is the configured one (curve or
   *  increment fallback), not a scenario's own. */
  private configuredStrategyRunning = false;

  private modeValue: ScenarioMode = "manual";
  private _autoResetToAvailable = true;
  private _evSettings: EVSettings = getDefaultEVSettings();
  // True while an explicit/scenario override is active (#105): a running
  // scenario's evSettings must win over any later Default EV Settings
  // propagation (e.g. a browser reload in remote mode re-pushing the
  // default onto every connector while a scenario is mid-flight on the
  // daemon). Cleared when the scenario that set it stops/completes.
  private _evSettingsOverridden = false;
  /** The charger's delivery cap on this connector in watts (#327);
   *  `undefined` when the hardware declares none. Set once at construction. */
  private _maxDeliveryPowerW: number | undefined;
  /** This connector's share of the station's power budget in watts, read at
   *  every resolve (#608); `undefined` when the station does not share. */
  private stationShareProvider: (() => number) | undefined;
  private _dcEfficiency: number | undefined;
  /** When the vehicle on the cable connected (epoch ms); the origin of its
   *  behavior's clock (#835). `null` with no cable. */
  private vehicleConnectedAt: number | null = null;
  /** Opt-in meter realism (#614-#616); `undefined` keeps the constant,
   *  historical output. Set once at construction, like the delivery cap. */
  private _meterRealism: MeterRealism | undefined;
  /** Energy exported so far in Wh (a V2X term, #615), as a float; runtime
   *  only. */
  private exportWh = 0;
  private exportTickedAt: number | null = null;
  private readonly energy = new ConnectorEnergy({
    now: () => this.clock.now(),
    meterValueWh: () => this.meterValueWh,
    setMeterValueWh: (v) => {
      this.meterValueWh = v;
    },
    socPercent: () => this.socPercent,
    setSocPercent: (v) => {
      this.socPercent = v;
    },
    socAwaitsNextTransaction: () => this.socAwaitsNextTransaction,
    setSocAwaitsNextTransaction: (v) => {
      this.socAwaitsNextTransaction = v;
    },
    patchTransaction: (fields) => this.patchTransaction(fields),
    exportWh: () => this.exportWh,
    exportRegisterWh: () => this.exportRegisterWh,
    setExportWh: (v) => {
      this.exportWh = v;
    },
    exportTickedAt: () => this.exportTickedAt,
    setExportTickedAt: (v) => {
      this.exportTickedAt = v;
    },
    socMeterSyncEnabled: () => this.socMeterSyncEnabledValue,
    meterRealism: () => this._meterRealism,
    evSettings: () => this._evSettings,
    transaction: () => this.transaction,
    sessionIntent: () => this.sessionIntent(),
    operatingPoint: () => this.operatingPoint(),
    isMeterSchedulerActive: () => this.meterScheduler.isActive(),
    stopMeterScheduler: () => this.meterScheduler.stop(),
    emit: (...args) => this.eventsEmitter.emit(...args),
  });
  private readonly runtimeSnapshot = new ConnectorRuntimeSnapshot({
    record: () => this.record,
    writeRecord: (w) => this.store.write(w),
    meterValueWh: () => this.meterValueWh,
    setMeterValueWh: (v) => {
      this.meterValueWh = v;
    },
    socPercent: () => this.socPercent,
    setSocPercent: (v) => {
      this.socPercent = v;
    },
    socAwaitsNextTransaction: () => this.socAwaitsNextTransaction,
    setSocAwaitsNextTransaction: (v) => {
      this.socAwaitsNextTransaction = v;
    },
    lastAutoStartedScenarioKey: () => this.lastAutoStartedScenarioKeyValue,
    setLastAutoStartedScenarioKey: (v) => {
      this.lastAutoStartedScenarioKeyValue = v;
    },
    setEvCableConnected: (v) => {
      this.evCableConnected = v;
    },
    setEvReady: (v) => {
      this.evReadyValue = v;
    },
    transaction: () => this.transaction,
    hasRunningTransaction: () => this.hasRunningTransaction,
    emit: (...args) => this.eventsEmitter.emit(...args),
  });
  private readonly scheduleLimiter = new ScheduleLimiter({
    nowDate: () => this.nowDate(),
    getActiveChargingProfile: (now) => this.getActiveChargingProfile(now),
    stationProfiles: () => this.stationProfilesProvider(),
    evSettings: () => this._evSettings,
    transaction: () => this.transaction,
    status: () => this.status,
    emitScheduleLimitChange: (e) =>
      this.eventsEmitter.emit("scheduleLimitChange", e),
  });
  private readonly vehicle = new ConnectorVehicle({
    now: () => this.clock.now(),
    evCableConnected: () => this.evCableConnected,
    vehicleConnectedAt: () => this.vehicleConnectedAt,
    setVehicleConnectedAt: (v) => {
      this.vehicleConnectedAt = v;
    },
    evSettings: () => this._evSettings,
    sessionIntent: () => this.sessionIntent(),
    transaction: () => this.transaction,
    hasRunningTransaction: () => this.hasRunningTransaction,
    meterValueWh: () => this.meterValueWh,
    effectiveSocPercent: () => this.effectiveSocPercent(),
  });
  private readonly profiles = new ConnectorChargingProfiles({
    nowDate: () => this.nowDate(),
    stationProfiles: () => this.stationProfilesProvider(),
    transaction: () => this.transaction,
    emitChargingProfilesChange: (e) =>
      this.eventsEmitter.emit("chargingProfilesChange", e),
    emitChargingProfileChange: (e) =>
      this.eventsEmitter.emit("chargingProfileChange", e),
  });

  snapshotRuntime(): ReturnType<ConnectorRuntimeSnapshot["snapshotRuntime"]> {
    return this.runtimeSnapshot.snapshotRuntime();
  }

  restoreRuntimeSnapshot(
    snapshot: Parameters<ConnectorRuntimeSnapshot["restoreRuntimeSnapshot"]>[0],
  ): void {
    this.runtimeSnapshot.restoreRuntimeSnapshot(snapshot);
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
    private readonly clock: SimClock = realClock,
  ) {
    this.stationProfilesProvider = stationProfilesProvider ?? (() => null);
    this.meterScheduler = new MeterValueScheduler(
      connectorId,
      {
        getCurrentValue: () => this.meterValueWh,
        updateValue: (value) => {
          // MaxEnergyOnInvalidId (E05.FR.03): the register stops at the
          // allowance, not one tick past it.
          const hold = this.invalidIdHoldAtWh;
          this.applyMeterValue(
            hold !== null && !this.energyHeldForInvalidId
              ? Math.min(value, hold)
              : value,
          );
          this.invalidIdAllowanceUsedUp();
        },
        onSend: (id) => {
          // #722: once the station owns the periodic sampling, the configured
          // strategy's ticks move the register without sending.
          if (this.stationOwnsMeterSampling && this.configuredStrategyRunning) {
            return;
          }
          if (this.onMeterSend) {
            this.onMeterSend(id);
          }
        },
        // Re-evaluated every tick so a schedule that crosses a period
        // boundary mid-transaction is honored immediately. Also folds in the
        // charging curve (#301): without one this returns exactly the
        // profile limit, unchanged from before the curve existed — with one,
        // the register and SoC advance at the same effective power
        // `MeterValueBuilder` reports, instead of the curve only ever
        // affecting the *reported* number while the register kept climbing
        // on its original trajectory.
        getDeliveryFactor: () => this.operatingPoint().deliveryFactor,
        onTick: () => this.integrateExport(),
        getScheduleLimitWatts: () => {
          // The register tick is a tick owner: it announces a schedule
          // crossing, the resolve itself is pure (#327).
          const point = this.operatingPoint();
          this.scheduleLimiter.announceScheduleCrossing(point.scheduleLimitW);
          return point.accumulationCapW;
        },
      },
      this.logger,
      this.clock,
    );
  }

  /** The injected clock's current instant. */
  private nowDate(): Date {
    return new Date(this.clock.now());
  }

  /** See {@link ScheduleLimiter.currentScheduleLimitWatts}. */
  currentScheduleLimitWatts(): number {
    return this.scheduleLimiter.currentScheduleLimitWatts();
  }

  /** See {@link ScheduleLimiter.scheduleConstraints}. */
  scheduleConstraints(): { watts: number; activePhases: number } {
    return this.scheduleLimiter.scheduleConstraints();
  }

  /** See {@link ScheduleLimiter.activePhaseCount}. */
  activePhaseCount(): number {
    return this.scheduleLimiter.activePhaseCount();
  }

  /**
   * Every physical quantity for this instant, resolved once (#327): the
   * schedule limit and phase count from one timestamp, then acceptance,
   * offer, currents, voltage, power factor and SoC from those. The energy
   * register ({@link MeterValueScheduler}) and the MeterValues builder both
   * read this record and never re-derive, so they cannot disagree and a new
   * limit term has exactly one place to go: {@link resolveOperatingPoint}.
   *
   * Pure, and the only resolver path: any reader (the console, behaviors'
   * snapshot, `EVSE.Power` #538) calls this and has no bookkeeping. A schedule
   * crossing is announced by the tick owners instead, with
   * {@link announceScheduleCrossingNow}: the register tick and the code that
   * sends a sample set.
   */
  operatingPoint(): OperatingPoint {
    const now = this.nowDate();
    const { watts, activePhases } =
      this.scheduleLimiter.resolveScheduleConstraints(now);
    return resolveOperatingPoint({
      at: now.getTime(),
      charging: this.status === OCPPStatus.Charging,
      soc: this.soc,
      schedule: { scheduleLimitW: watts, activePhases },
      vehicle: vehicleTermOf(this._evSettings),
      session: { initialSoc: this.sessionIntent().initialSoc },
      charger: chargerTermOf(this._maxDeliveryPowerW, {
        stationShareW: this.stationShareProvider?.(),
        conversionEfficiency: this._dcEfficiency,
      }),
      demand: this.vehicle.vehicleDemandTerm(now.getTime()),
      meter: {
        realism: this._meterRealism,
        sessionStartedAt: this.hasRunningTransaction
          ? this.transaction?.startTime?.getTime()
          : undefined,
      },
      fault: {
        // A running transaction in a state where the EVSE energizes the
        // connector; SuspendedEVSE and everything outside the session offer
        // nothing (OCPP 1.6 §7.7, §7.31). A transaction that stays
        // SuspendedEV after an EV-side disconnect has no EV to offer to
        // (#846); an EV that is merely not ready (`ev_ready(false)`) is
        // offered. Charging is not gated: a 2.x start can run Charging before
        // the cable flag is set.
        offering:
          this.hasRunningTransaction &&
          (this.status === OCPPStatus.Charging ||
            (this.status === OCPPStatus.SuspendedEV &&
              this.evConnection !== "disconnected")),
        energyOfferSuspended: this.energyOfferSuspendedValue,
        // Resolved after the schedule, as before (#301); E05.FR.02.
        energyHeld: this.invalidIdAllowanceUsedUp(),
      },
    });
  }

  /** The hardware's delivery cap on this connector in watts, `undefined`
   *  when none is declared (#327). */
  get maxDeliveryPowerW(): number | undefined {
    return this._maxDeliveryPowerW;
  }

  /** Declare the charger's delivery cap (watts, or `undefined` for none). The
   *  hardware does not change at run time: call this when the connector is
   *  built, before it samples. */
  setMaxDeliveryPowerW(watts: number | undefined): void {
    this._maxDeliveryPowerW = watts;
  }

  /** Let the station divide its power (#608): `provider` returns this
   *  connector's share in watts and is read at every resolve, so a transaction
   *  that starts or stops elsewhere moves it at once. */
  setStationShareProvider(provider: (() => number) | undefined): void {
    this.stationShareProvider = provider;
  }

  /** The conversion efficiency in force on this connector (#608): 1 unless a
   *  DC vehicle is on a charger with a configured efficiency. */
  get conversionEfficiency(): number {
    return conversionEfficiencyOf(
      this._evSettings.currentType,
      this._dcEfficiency,
    );
  }

  /** Declare the DC conversion efficiency in (0, 1] (#608). */
  setDcEfficiency(efficiency: number | undefined): void {
    this._dcEfficiency = efficiency;
  }

  /** See {@link ConnectorVehicle.vehicleBehavior}. */
  get vehicleBehavior(): VehicleBehaviorSpec | null {
    return this.vehicle.vehicleBehavior;
  }

  /** See {@link ConnectorVehicle.ensureVehicleSession}. */
  ensureVehicleSession(): void {
    this.vehicle.ensureVehicleSession();
  }

  /** See {@link ConnectorVehicle.vehicleSnapshot}. */
  vehicleSnapshot(): VehicleSnapshot | null {
    return this.vehicle.vehicleSnapshot();
  }

  /** The opt-in meter realism of this connector, `undefined` when none. */
  get meterRealism(): MeterRealism | undefined {
    return this._meterRealism;
  }

  /** Declare the meter realism (#614-#616); call when the connector is
   *  built, before it samples. */
  setMeterRealism(realism: MeterRealism | undefined): void {
    this._meterRealism = realism;
  }

  /** Energy exported so far in whole Wh (`Energy.Active.Export.Register`). */
  get exportRegisterWh(): number {
    return Math.round(this.exportWh);
  }

  /** See {@link ConnectorEnergy.integrateExport}. */
  private integrateExport(): void {
    this.energy.integrateExport();
  }

  /** See {@link ConnectorEnergy.takeIntervalEnergyWh}. */
  takeIntervalEnergyWh(stream = "sampled"): {
    importWh: number;
    exportWh: number;
  } {
    return this.energy.takeIntervalEnergyWh(stream);
  }

  /**
   * Announce a schedule crossing (`scheduleLimitChange`) if the paused/active
   * boundary moved since the last announcement. For a tick owner to call once
   * before it samples; edge-triggered, so an extra call at an unchanged
   * boundary emits nothing.
   */
  announceScheduleCrossingNow(): void {
    this.scheduleLimiter.announceScheduleCrossing(
      this.operatingPoint().scheduleLimitW,
    );
  }

  /** This session's opening and target SoC: see {@link resolveSessionIntent}. */
  sessionIntent(): SessionIntent {
    return resolveSessionIntent(
      this.transaction,
      this._evSettings,
      this.autoConfig.stopAtTargetSoc,
    );
  }

  private socFromMeterValue(meterValueWh: number): number | null {
    return this.energy.socFromMeterValue(meterValueWh);
  }

  get id(): number {
    return this.connectorId;
  }

  get events(): EventEmitter<ConnectorEvents> {
    return this.eventsEmitter;
  }

  get status(): OCPPStatus {
    return this.store.read().status;
  }

  /**
   * TRANSITIONAL (removed with #575): kept so callers and tests need not change.
   * A bare write: only this connector's own `statusChange` listeners hear it.
   */
  set status(newStatus: OCPPStatus) {
    this.store.write({ kind: "status", status: newStatus, scope: "local" });
  }

  get availability(): OCPPAvailability {
    return this.store.read().availability;
  }

  set availability(newAvailability: OCPPAvailability) {
    this.store.write({
      kind: "availability",
      availability: newAvailability,
    });
  }

  /** Pending availability that should be applied once the in-flight
   *  transaction ends (set by ChangeAvailability while charging). */
  get scheduledAvailability(): OCPPAvailability | null {
    return this.store.read().scheduledAvailability;
  }

  set scheduledAvailability(value: OCPPAvailability | null) {
    this.store.write({ kind: "scheduledAvailability", value });
  }

  get currentErrorCode(): ChargePointErrorCode {
    return this.store.read().errorCode;
  }

  set currentErrorCode(code: ChargePointErrorCode) {
    this.store.write({ kind: "errorCode", errorCode: code });
  }

  get errorInfo(): string | null {
    return this.store.read().errorInfo;
  }

  set errorInfo(info: string | null) {
    this.store.write({ kind: "errorInfo", errorInfo: info });
  }

  get vendorErrorCode(): string | null {
    return this.store.read().vendorErrorCode;
  }

  set vendorErrorCode(code: string | null) {
    this.store.write({ kind: "vendorErrorCode", vendorErrorCode: code });
  }

  /** The record as it is now. */
  get record(): ConnectorRecord {
    return this.store.read();
  }

  /**
   * Move the record into `store` (the charger engine's state) or, with
   * `null`, back into a private cell that starts from `last`.
   */
  bindStore(store: ConnectorStateStore | null, last?: ConnectorRecord): void {
    if (store) {
      this.store = store;
      return;
    }
    this.localRecord = last ?? this.store.read();
    this.store = this.createLocalStore();
  }

  private createLocalStore(): ConnectorStateStore {
    return {
      read: () => this.localRecord,
      write: (write) => {
        const previous = this.localRecord;
        this.localRecord = reduceConnectorRecord(previous, write);
        this.applyWrite(previous, write);
      },
    };
  }

  /**
   * Called by the store after `write` changed the record from `previous`:
   * the connector-local side of a write (its `statusChange` and
   * `availabilityChange` listeners).
   */
  applyWrite(previous: ConnectorRecord, write: ConnectorWrite): void {
    switch (write.kind) {
      case "status":
        if (write.status !== OCPPStatus.SuspendedEV) {
          this.energyOfferSuspendedValue = false;
        }
        this.eventsEmitter.emit("statusChange", {
          status: write.status,
          previousStatus: previous.status,
        });
        break;
      case "availability":
        this.eventsEmitter.emit("availabilityChange", {
          availability: write.availability,
        });
        break;
      case "transaction.set":
        this.rebuildTransactionView(write.transaction);
        break;
      case "transaction.patch":
        if (this.txTarget) applyPatchToTransaction(this.txTarget, write.patch);
        break;
      case "restore":
        if (write.transaction !== undefined) {
          this.rebuildTransactionView(write.transaction);
        }
        break;
      default:
        break;
    }
  }

  private rebuildTransactionView(record: TransactionRecord | null): void {
    if (!record) {
      this.txTarget = null;
      this.txView = null;
      return;
    }
    const target = transactionOfRecord(record);
    this.txTarget = target;
    this.txView = new Proxy(target, {
      // A view kept past the end of its transaction is detached: it writes
      // into its own record, never into the transaction that replaced it.
      set: (viewTarget, key, value) => {
        if (typeof key !== "string") return false;
        if (this.txTarget !== viewTarget) {
          return Reflect.set(viewTarget, key, value);
        }
        this.store.write({
          kind: "transaction.patch",
          patch: patchOfFields({ [key]: value }),
        });
        return true;
      },
      deleteProperty: (viewTarget, key) => {
        if (typeof key !== "string") return false;
        if (this.txTarget !== viewTarget) {
          return Reflect.deleteProperty(viewTarget, key);
        }
        this.store.write({
          kind: "transaction.patch",
          patch: patchOfFields({ [key]: undefined }),
        });
        return true;
      },
    });
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
        this.socAwaitsNextTransaction = false;
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
    // Set while idle it is a statement about the car plugged in now and waits
    // for the transaction about to start; set mid-session it describes that
    // session's car and is replaced when the next one begins (#301).
    this.socAwaitsNextTransaction = !this.hasRunningTransaction;
    this.eventsEmitter.emit("socChange", { soc: value });
    this.checkAutoStop();
  }

  /**
   * Whether a session is running right now: a transaction that has begun and
   * not yet stopped.
   *
   * Deliberately not "a transaction object is attached".
   * `ChargePoint.cleanTransaction` stamps `stopTime` without detaching the
   * object, and a `connector_runtime` snapshot persisted before #491 (when a
   * CALLERROR start stayed attached) restores one that way — so the connector
   * can be logically idle with a transaction still hanging off it.
   * `ChargePoint.stopTransaction` asks this before stopping (#491), and
   * `ChargePoint.startTransaction` already asks the
   * question this way before refusing a duplicate start; asking it the same
   * way here is what lets a hand retry after a rejection behave like a first
   * attempt, which is precisely when an operator is most likely to be typing
   * an SoC before pressing Start (#301).
   */
  get hasRunningTransaction(): boolean {
    return this.transaction !== null && this.transaction.stopTime === null;
  }

  /** See {@link energyHeldForInvalidId}. */
  get energyHeld(): boolean {
    return this.energyHeldForInvalidId;
  }

  /**
   * Stop the energy delivery of the running transaction after a non-Accepted
   * idTokenInfo / idTagInfo with `StopTransactionOnInvalidId=false`. With
   * `allowanceWh` > 0 that much more energy is delivered first
   * (`MaxEnergyOnInvalidId`, E05.FR.03); the connector then emits
   * `invalidIdEnergyExhausted`. Returns true when the hold is already in
   * force (the caller reports SuspendedEVSE now).
   */
  holdEnergyForInvalidId(allowanceWh: number): boolean {
    if (allowanceWh > 0) {
      this.invalidIdHoldAtWh ??= this.meterValueWh + allowanceWh;
      return this.invalidIdAllowanceUsedUp();
    }
    this.energyHeldForInvalidId = true;
    return true;
  }

  private invalidIdAllowanceUsedUp(): boolean {
    if (this.energyHeldForInvalidId) return true;
    if (this.invalidIdHoldAtWh === null) return false;
    if (this.meterValueWh < this.invalidIdHoldAtWh) return false;
    this.energyHeldForInvalidId = true;
    this.eventsEmitter.emit("invalidIdEnergyExhausted", {});
    return true;
  }

  /** See {@link energyOfferSuspendedValue} (#488). */
  get energyOfferSuspended(): boolean {
    return this.energyOfferSuspendedValue;
  }

  /** The EV and cable state now (#453), see {@link EvConnectionState}. */
  get evConnection(): EvConnectionState {
    return evConnectionOf(this.evCableConnected, this.evReadyValue);
  }

  /** Record the cable as plugged in; the EV is ready until it says otherwise.
   *  The status change that follows is the charge point's (#453). */
  markEvPluggedIn(): void {
    this.evCableConnected = true;
    this.evReadyValue = true;
    this.vehicleConnectedAt = this.clock.now();
  }

  /** Record the cable as unplugged. */
  markEvUnplugged(): void {
    this.evCableConnected = false;
    this.evReadyValue = true;
    this.vehicleConnectedAt = null;
  }

  /** Record the EV as ready or not ready for energy; needs a plugged-in cable. */
  markEvReady(ready: boolean): void {
    this.evReadyValue = ready;
  }

  /** Stop the energy offer of the running transaction after an EV-side
   *  disconnect (#488): the register freezes, sampling goes on. */
  suspendEnergyOffer(): void {
    this.energyOfferSuspendedValue = true;
  }

  /**
   * TRANSITIONAL (removed with #575): a live `Proxy` view of the engine's record;
   * assigning stores a copy, so the view is not the object you assigned.
   */
  get transaction(): Transaction | null {
    return this.txView;
  }

  set transaction(transaction: Transaction | null) {
    if (transaction !== null && transaction === this.txView) return;
    this.store.write({
      kind: "transaction.set",
      transaction: transaction ? recordOfTransaction(transaction) : null,
    });
  }

  /** Detach the transaction without announcing it (no `transactionChange`). */
  detachTransaction(): void {
    this.store.write({ kind: "transaction.set", transaction: null });
  }

  /**
   * Change fields of the transaction on this connector, through the engine
   * (an `undefined` value removes the field). No-op without a transaction.
   */
  patchTransaction(fields: Partial<Record<keyof Transaction, unknown>>): void {
    if (!this.txTarget) return;
    this.store.write({
      kind: "transaction.patch",
      patch: patchOfFields(fields),
    });
  }

  markTransactionChanged(): void {
    this.eventsEmitter.emit("transactionChange", {
      transaction: this.transaction,
    });
  }

  /** OCPP 1.6 (#527): a CALLERROR answered the running transaction's
   *  StartTransaction.req; its `0` id is now a placeholder the CSMS failed
   *  to process. Emits `transactionChange` so the flag is persisted. */
  markStartCallError(): void {
    if (!this.txTarget || this.txTarget.startCallError) return;
    this.store.write({
      kind: "transaction.patch",
      patch: { startCallError: true },
    });
    this.markTransactionChanged();
  }

  set transactionId(transactionId: number) {
    this.assignTransactionId(transactionId);
  }

  /** The CSMS assigned `transactionId` (StartTransaction.conf). */
  assignTransactionId(transactionId: number): void {
    if (!this.txTarget) return;
    this.store.write({
      kind: "transaction.patch",
      patch: {
        id: transactionId,
        startCallError: undefined,
        startUnanswered: undefined,
      },
    });
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
    // Normalized here, at the one boundary every write to evSettings passes
    // through (the setter, `applyEvSettingsOverride` and
    // `applyDefaultEvSettings` all funnel here) — so every reader
    // (`powerFractionAtSoc`, the meter scheduler) can assume an
    // already-sorted, already-validated curve rather than re-normalizing
    // per sample (#301).
    // A `null` is a merge patch's "remove" (#458): never stored, and refused
    // for a required field before anything is written.
    assertRequiredFieldsKept(settings);
    this._evSettings = withNormalizedChargingCurve(
      withoutNulls({ ...settings }),
    );
    this.eventsEmitter.emit("evSettingsChange", { settings: this._evSettings });
  }

  /**
   * Explicit/scenario set (#105): merges `partial` into the current EV
   * settings and marks the connector as overridden, so a later Default EV
   * Settings propagation (`applyDefaultEvSettings`) no-ops until
   * {@link clearEvSettingsOverride} runs.
   */
  applyEvSettingsOverride(partial: EVSettingsPatch): void {
    // Refused before the override is claimed: a rejected write changes
    // nothing, the ownership included.
    assertRequiredFieldsKept(partial);
    this._evSettingsOverridden = true;
    // A merge patch: absent keys keep their value, `null` removes the key
    // (the setter drops it).
    this.evSettings = { ...this._evSettings, ...partial } as EVSettings;
  }

  /**
   * Default-EV-settings propagation (#105), only when no override is active —
   * a running scenario/explicit override wins over this until cleared.
   *
   * Merged onto the built-in {@link defaultEVSettings} (#333), as
   * {@link applyEvSettingsOverride} merges onto the current settings: a field
   * the default omits reads back as the built-in value rather than vanishing,
   * so a partial `ev_settings.apply_default` can no longer leave a required
   * field such as `initialSoc` absent. Onto the constant, not the current
   * settings: a default that names no `chargingCurve` describes a car without
   * one, so nothing of an earlier default or override carries over.
   */
  applyDefaultEvSettings(settings: EVSettingsPatch): void {
    if (this._evSettingsOverridden) return;
    this.evSettings = { ...defaultEVSettings, ...settings } as EVSettings;
  }

  /**
   * Unmark the override (current values are kept as-is) so the next
   * `applyDefaultEvSettings` call can take effect. Called when the scenario
   * that set the override stops or completes.
   */
  clearEvSettingsOverride(): void {
    this._evSettingsOverridden = false;
  }

  /** Get all charging profiles for this connector, highest stack level first. */
  get chargingProfiles(): ActiveChargingProfile[] {
    return this.profiles.chargingProfiles;
  }

  /** See {@link ConnectorChargingProfiles.getActiveChargingProfile}. */
  getActiveChargingProfile(
    now: Date = this.nowDate(),
  ): ActiveChargingProfile | null {
    return this.profiles.getActiveChargingProfile(now);
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
    this.profiles.chargingProfile = profile;
  }

  /** Add or update a charging profile; returns whether one was replaced. */
  addChargingProfile(
    profile: ActiveChargingProfile,
    options: ApplyChargingProfileOptions = {},
  ): boolean {
    return this.profiles.addChargingProfile(profile, options);
  }

  /** Remove the charging profiles matching every given criterion. */
  takeChargingProfiles(
    criteria: ProfileRemoveCriteria,
  ): ActiveChargingProfile[] {
    return this.profiles.takeChargingProfiles(criteria);
  }

  /** Clear all charging profiles. */
  clearAllChargingProfiles(): void {
    this.profiles.clearAllChargingProfiles();
  }

  /** Set all charging profiles (replaces existing profiles). */
  setChargingProfiles(profiles: ActiveChargingProfile[]): void {
    this.profiles.setChargingProfiles(profiles);
  }

  get autoMeterValueConfig(): AutoMeterValueConfig {
    return this.autoConfig;
  }

  /**
   * Every path that can configure the auto-meter funnels through here — the
   * browser panels via `LocalChargePointService`, the CLI's `service.ts`, and
   * the control plane's `set_auto_meter_config`, whose payload schema
   * validates no field of the config at all — so this is where the curve's
   * contract is enforced (#332).
   *
   * The stored **and emitted** config is the normalized one: a subscriber that
   * renders the curve, and a `get_auto_meter_value_config` read-back, must see
   * the trajectory the scheduler will actually run, not the one that was
   * rejected. A curve already within contract is stored by identity, so this
   * adds no spurious change event.
   */
  set autoMeterValueConfig(config: AutoMeterValueConfig) {
    const normalized = withNormalizedCurvePoints(config, (message) =>
      this.logger.warn(
        `[Connector ${this.connectorId}] auto-meter curve: ${message}`,
      ),
    );
    this.autoConfig = normalized;
    this.eventsEmitter.emit("autoMeterValueChange", { config: normalized });

    if (this.transaction) {
      this.startConfiguredMeterValue();
    }
  }

  setIncrementFallback(config: IncrementStrategyConfig | null): void {
    this.incrementFallback = config;
    if (this.transaction && !this.autoConfig.enabled) {
      this.startConfiguredMeterValue();
    }
  }

  setOnMeterValueSend(callback: (connectorId: number) => void): void {
    this.onMeterSend = callback;
  }

  /** `startTime` of the last transaction begun here, in ms (#586). */
  private lastStartMs = -Infinity;

  /**
   * OCPP 1.x: the start time of a new transaction, which is `now` unless it
   * equals the previous transaction's on this connector to the millisecond.
   * A StartTransaction.req is matched to its transaction by `idTag` and
   * `timestamp`, so a stop then a start by the same tag within one
   * millisecond must not produce the same pair (#586); the wire timestamp is
   * 1 ms later in that one case. Only an actual collision bumps it: a clock
   * stepped back keeps stamping the clock's time.
   */
  nextStartTime(now: Date): Date {
    return now.getTime() === this.lastStartMs
      ? new Date(now.getTime() + 1)
      : now;
  }

  beginTransaction(transaction: Transaction): void {
    this.lastStartMs = transaction.startTime.getTime();
    this.store.write({
      kind: "transaction.set",
      transaction: recordOfTransaction(transaction),
    });
    // A new session has announced nothing yet. `lastSchedulePaused` records
    // what *this* session last told the ChargePoint, and the listener it
    // feeds no-ops without a transaction — so "already announced" is only a
    // meaningful claim inside one transaction, and the latch's lifetime is
    // exactly that. Left standing across the boundary it silenced the next
    // session: only `TxProfile` is cleared when a transaction ends, so a
    // station-level or `TxDefaultProfile` at `limit: 0` stays in force, the
    // uncapped resolve that would otherwise disarm the latch never happens
    // (nothing samples between sessions), and the first resolve of the next
    // transaction matched the stale `true` and stayed silent — `Charging`
    // reported with the meter capped at zero (#301). Re-arming here, rather
    // than at `stopTransaction`, is deliberate: this is the only path that
    // attaches a transaction to this connector, and any resolve in the gap
    // has no `startTime` to resolve against and so disarms on its own.
    this.scheduleLimiter.rearm();
    this.energyOfferSuspendedValue = false;
    // A transaction means an EV on the cable (#453): a start without a prior
    // plug-in, and a restored transaction, imply one.
    // `ev_ready(false)` recorded before the start stays (1.6 §4.9 B4: the EV
    // is not ready, so the session goes to SuspendedEV, #846).
    if (!this.evCableConnected) this.evReadyValue = true;
    this.evCableConnected = true;
    this.ensureVehicleSession();
    this.energyHeldForInvalidId = false;
    this.invalidIdHoldAtWh = null;
    this.openSessionSoc(this.txView ?? transaction);
    // The export integral starts with the session, never at the previous one's
    // last tick (#826 review).
    this.exportTickedAt = this.clock.now();
    this.startConfiguredMeterValue();
    this.eventsEmitter.emit("transactionChange", { transaction });
  }

  /** See {@link ConnectorEnergy.openSessionSoc}. */
  private openSessionSoc(transaction: Transaction): void {
    this.energy.openSessionSoc(transaction);
  }

  stopTransaction(): void {
    this.meterScheduler.stop();
    this.exportTickedAt = null;
    this.store.write({ kind: "transaction.set", transaction: null });
    this.eventsEmitter.emit("transactionChange", { transaction: null });
  }

  /** #722: see {@link stationOwnsMeterSampling}. */
  setStationOwnsMeterSampling(owns: boolean): void {
    this.stationOwnsMeterSampling = owns;
  }

  startManualMeterStrategy(strategy: MeterValueStrategy): void {
    this.configuredStrategyRunning = false;
    this.meterScheduler.start(strategy);
  }

  startConfiguredMeterValue(): void {
    if (!this.transaction) return;

    this.configuredStrategyRunning = true;
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

    this.configuredStrategyRunning = false;
    this.meterScheduler.stop();
  }

  stopAutoMeterValue(): void {
    this.configuredStrategyRunning = false;
    this.meterScheduler.stop();
    this.exportTickedAt = null;
  }

  isAutoMeterValueActive(): boolean {
    return this.meterScheduler.isActive();
  }

  cleanup(): void {
    this.meterScheduler.cleanup();
  }

  dispose(): void {
    this.cleanup();
    // Before the listeners go, so a subscriber can still tear down what it
    // keeps for this connector (a scenario runtime destroys its manager).
    this.eventsEmitter.emit("disposed", {});
    this.eventsEmitter.removeAllListeners();
    this.onMeterSend = null;
    // Intentionally do NOT clear the transaction / `socPercent` in either
    // runtime cleanup or full dispose. Disconnect/reconnect paths rely on those
    // values so post-boot StatusNotifications can describe the live connector
    // state instead of orphaning an in-flight transaction at the CSMS side.
  }

  private applyMeterValue(value: number): void {
    this.energy.applyMeterValue(value);
  }

  private effectiveSocPercent(): number | null {
    return this.energy.effectiveSocPercent();
  }

  private checkAutoStop(): void {
    this.energy.checkAutoStop();
  }
}
