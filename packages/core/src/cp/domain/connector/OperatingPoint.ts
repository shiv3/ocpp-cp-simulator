import {
  currentAmpsFor,
  effectiveChargingPowerW,
  effectivePowerFactor,
  effectiveVoltageV,
  resolveSocForCurve,
} from "./ChargingCurve";
import type { EVSettings } from "./EVSettings";

/**
 * The physical state of one connector at one instant, resolved once.
 *
 * Protocol-agnostic on purpose: this module imports nothing from
 * `cp/infrastructure/transport/` or `ocpp/`. MeterValues, the energy register
 * and `Power.Offered` all read the same record and only format it, so a
 * quantity cannot be derived differently by the path that accumulates and the
 * path that reports (#327). "Every sample in one MeterValue describes one
 * instant" is structural here: every field below comes from the same inputs.
 */
export interface OperatingPoint {
  /** Epoch ms the schedule was resolved at. */
  at: number;
  /** Active charging-profile cap in watts, `Infinity` when uncapped. */
  scheduleLimitW: number;
  /** Phases in use: the wiring (1 for DC) narrowed by the profile. */
  activePhases: number;
  /** What the battery accepts now, curve included; 0 unless `Charging`. */
  acceptedW: number;
  /** What the EVSE offers now, curve excluded; 0 unless `Charging`. */
  offeredW: number;
  /** Line current for {@link acceptedW}, over {@link activePhases}. */
  currentA: number;
  /** Line current for {@link offeredW}, over {@link activePhases}. */
  offeredCurrentA: number;
  /** {@link scheduleLimitW} in amperes, `Infinity` when uncapped. */
  limitA: number;
  /** The voltage that produced the currents, not the raw configured value. */
  voltageV: number;
  /** The cos φ that produced the currents, not the raw configured value. */
  powerFactor: number;
  /** State of charge in percent, `null` before the first synced tick. */
  soc: number | null;
  /**
   * The ceiling the energy register accumulates against. Differs from
   * {@link acceptedW} in two deliberate ways: it is not gated on `Charging`
   * (the scheduler ticks through pauses), and with no curve it is exactly the
   * schedule limit (`Infinity` when uncapped), so a curve-less scenario keeps
   * its own increment trajectory. 0 while the energy offer is suspended.
   *
   * Upper bound on this tick's register delta, not a cap on acceptance. Pinned
   * by `OperatingPoint.agreement.test.ts`:
   *
   * - charging with a curve (and a finite vehicle ceiling):
   *   `accumulationCapW === acceptedW`;
   * - no curve: `accumulationCapW === scheduleLimitW` (the charger cap joins
   *   it here when it exists, #327 step 4);
   * - energy offer suspended: `0`;
   * - any other status: same as the charging case. Whether the register ticks
   *   at all is the scheduler's decision, not the point's.
   */
  accumulationCapW: number;
  /**
   * What binds the offer, for diagnostics (`ConnectorSnapshot.power`); never
   * on the wire. `"suspended"` while the energy offer is withheld,
   * `"schedule"` when the profile cap is below what the vehicle would take,
   * `"vehicle"` when the vehicle's ceiling or curve is the tightest known
   * term, `"none"` when nothing is known to bind. The charger cap joins in
   * step 4.
   */
  limitedBy: OperatingPointLimit;
}

export type OperatingPointLimit = "schedule" | "vehicle" | "suspended" | "none";

/** The CSMS allocation, resolved from one instant. */
export interface ScheduleTerm {
  /** Active charging-profile cap in watts, `Infinity` when uncapped. */
  scheduleLimitW: number;
  /** Wiring narrowed by the profile's `numberPhases`; never 0. */
  activePhases: number;
}

/**
 * The car side, resolved. Built by {@link vehicleTermOf} from the connector's
 * resolved EV settings (never from a profile store or catalogue: the
 * offline guarantee of #458), so the resolver sees one ceiling and one curve.
 */
export interface VehicleTerm {
  /** The vehicle's own ceiling in watts, `Infinity` when unconfigured. */
  maxW: number;
  /** Battery-acceptance curve; `undefined` or empty for flat acceptance. */
  curve: EVSettings["chargingCurve"];
  /** Voltage, phases, current type and cos φ the currents are derived with;
   *  `{}` for a connector that declares no electrical model. */
  electrical: Partial<EVSettings>;
}

/** The session the vehicle is charging for (see {@link SessionIntent}). */
export interface SessionTerm {
  /** Opening SoC of this session when known; seeds the curve before the
   *  first synced tick. */
  initialSoc: number | undefined;
}

/** What can pause or zero the offer. */
export interface FaultTerm {
  /** `SuspendedEV`: the register ticks but the offer is withheld. */
  energyOfferSuspended: boolean;
  /** The id of the running transaction was not accepted and the
   *  `MaxEnergyOnInvalidId` allowance is used up (E05.FR.02): the register
   *  stops rising, the offer itself is unchanged. */
  energyHeld?: boolean;
}

/** The input terms of one resolve (#327). Required and non-nullable on
 *  purpose: a caller cannot hand the resolver a half-built vehicle. */
export interface OperatingPointInputs {
  /** Epoch ms the schedule was resolved at (the connector's `SimClock`). */
  at: number;
  /** `Charging` right now; the only status that accepts power. */
  charging: boolean;
  /** Connector SoC in percent, `null` before the first synced tick. */
  soc: number | null;
  schedule: ScheduleTerm;
  vehicle: VehicleTerm;
  session: SessionTerm;
  fault: FaultTerm;
}

/** The vehicle term for the connector's resolved EV settings (`undefined`:
 *  none yet, i.e. unknown ceiling and no electrical model). */
export function vehicleTermOf(settings: EVSettings | undefined): VehicleTerm {
  const maxKw = settings?.maxChargingPowerKw ?? 0;
  return {
    maxW: maxKw > 0 ? maxKw * 1000 : Infinity,
    curve: settings?.chargingCurve,
    electrical: settings ?? {},
  };
}

/** Resolve every physical quantity for one instant from already-resolved
 *  input terms. Pure: no clock, no connector, no store. */
export function resolveOperatingPoint(
  inputs: OperatingPointInputs,
): OperatingPoint {
  const { at, schedule, vehicle, session, fault } = inputs;
  const { scheduleLimitW, activePhases } = schedule;
  const { maxW: evMaxW, curve, electrical } = vehicle;
  const curveSoc = resolveSocForCurve(
    inputs.soc,
    session.initialSoc,
    undefined,
  );

  const acceptedW = inputs.charging
    ? effectiveChargingPowerW({
        evMaxW,
        curve,
        socPercent: curveSoc,
        scheduleLimitWatts: scheduleLimitW,
      })
    : 0;
  // The curve describes battery acceptance, not EVSE capability: a 100 kW
  // charger still offers 100 kW to a nearly full battery (#301).
  const offeredW = inputs.charging
    ? effectiveChargingPowerW({
        evMaxW,
        curve: undefined,
        socPercent: null,
        scheduleLimitWatts: scheduleLimitW,
      })
    : 0;

  let accumulationCapW: number;
  if (fault.energyOfferSuspended || fault.energyHeld) {
    accumulationCapW = 0;
  } else if (!curve || curve.length === 0 || !Number.isFinite(evMaxW)) {
    accumulationCapW = scheduleLimitW;
  } else {
    accumulationCapW = effectiveChargingPowerW({
      evMaxW,
      curve,
      socPercent: curveSoc,
      scheduleLimitWatts: scheduleLimitW,
    });
  }

  return {
    at,
    scheduleLimitW,
    activePhases,
    acceptedW,
    offeredW,
    currentA: currentAmpsFor(acceptedW, electrical, activePhases),
    offeredCurrentA: currentAmpsFor(offeredW, electrical, activePhases),
    limitA: currentAmpsFor(scheduleLimitW, electrical, activePhases),
    voltageV: effectiveVoltageV(electrical),
    powerFactor: effectivePowerFactor(electrical),
    soc: inputs.soc,
    accumulationCapW,
    limitedBy: limitedByOf(
      fault.energyOfferSuspended,
      scheduleLimitW,
      effectiveChargingPowerW({
        evMaxW,
        curve,
        socPercent: curveSoc,
        scheduleLimitWatts: Infinity,
      }),
      evMaxW,
    ),
  };
}

/** What binds the offer, for diagnostics. Evaluated whatever the status, as
 *  "what would bind if it were charging". `vehicleW` is 0 when the vehicle's
 *  ceiling is unknown, which counts as no vehicle limit. */
function limitedByOf(
  suspended: boolean,
  scheduleLimitW: number,
  vehicleW: number,
  evMaxW: number,
): OperatingPointLimit {
  if (suspended) return "suspended";
  if (Number.isFinite(evMaxW) && scheduleLimitW < vehicleW) return "schedule";
  if (!Number.isFinite(evMaxW) && Number.isFinite(scheduleLimitW)) {
    return "schedule";
  }
  return Number.isFinite(evMaxW) ? "vehicle" : "none";
}
