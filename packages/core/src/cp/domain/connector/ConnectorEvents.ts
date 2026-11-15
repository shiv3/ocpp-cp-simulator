import type { AutoMeterValueConfig } from "./MeterValueCurve";
import type {
  OCPPAvailability,
  OCPPStatus,
  ChargingProfileKindType,
  ChargingProfilePurposeType,
  ChargingRateUnitType,
  RecurrencyKindType,
} from "../types/OcppTypes";
import type { ScenarioMode } from "@ocpp-cp-simulator/contracts/scenario";
import type { Transaction } from "./Transaction";
import type { EVSettings } from "./EVSettings";

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
  /**
   * `chargingSchedule.startSchedule`: the instant an Absolute or Recurring
   * schedule's `startPeriod` offsets count from (1.6 §7.13). Distinct from
   * `validFrom`, which only bounds when the profile may apply.
   */
  startSchedule?: string; // ISO 8601 timestamp
  /** `chargingSchedule.duration` in seconds: the schedule ends after it (per cycle for Recurring). */
  duration?: number;
  /** `chargingSchedule.minChargingRate`, kept so the profile round-trips. */
  minChargingRate?: number;
  chargingSchedulePeriods: ChargingSchedulePeriod[];
}

export interface ConnectorEvents {
  statusChange: { status: OCPPStatus; previousStatus: OCPPStatus };
  /**
   * Fires when `beginTransaction` or `stopTransaction` flips the
   * `transaction` field, distinct from `transactionIdChange`
   * (which only fires when the CSMS confirms a real id on an
   * already-active transaction). Persistence listeners use this to
   * catch the "transaction object just started" / "just cleared" edges
   * without needing a polling read.
   */
  transactionChange: { transaction: Transaction | null };
  transactionIdChange: { transactionId: number };
  /**
   * `restoreRuntimeSnapshot` put a running transaction back after a restart.
   * `transactionChange` stays silent on a restore (it would persist and
   * announce what is already stored), so a subscriber that has to act on a
   * transaction that is running again (the periodic sampler, #722) listens
   * to this one.
   */
  transactionRestored: { transaction: Transaction };
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
  /** The `MaxEnergyOnInvalidId` allowance of a transaction whose id was not
   *  accepted is used up: the energy hold has just started (E05.FR.02;
   *  2.x only, 1.6 errata 3.17 is #736). The ChargePoint moves the connector to
   *  SuspendedEVSE. */
  invalidIdEnergyExhausted: Record<string, never>;
  /** `dispose()` is tearing the connector down (the ChargePoint removed it).
   *  Emitted once, before every listener is dropped. */
  disposed: Record<string, never>;
}
