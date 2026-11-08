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
  /** The charger's delivery cap for this connector in watts (hardware, not
   *  the CSMS), `Infinity` when none is declared (#327). */
  chargerCapW: number;
  /** The tightest limit the report is bounded by: the schedule limit and the
   *  charger cap, `Infinity` when neither exists. Samples round against this,
   *  never past it. */
  boundW: number;
  /** Phases in use: the wiring (1 for DC) narrowed by the profile. */
  activePhases: number;
  /** What the battery accepts now, curve included; 0 unless `Charging`. */
  acceptedW: number;
  /** What the EVSE offers now, curve excluded; 0 unless the EVSE is
   *  energized: a running transaction in `Charging` or `SuspendedEV`
   *  (see {@link FaultTerm.offering}). */
  offeredW: number;
  /** Line current for {@link acceptedW}, over {@link activePhases}. */
  currentA: number;
  /** Line current for {@link offeredW}, over {@link activePhases}. */
  offeredCurrentA: number;
  /** {@link boundW} in amperes, `Infinity` when unbounded. */
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
   * - no curve: `accumulationCapW === boundW`, the schedule limit narrowed by
   *   the charger cap, so the register and `Power.Active.Import` cannot
   *   disagree about it;
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
   * term, `"charger"` when the charger cap is below the schedule limit and
   * the vehicle's ceiling, `"none"` when nothing is known to bind.
   */
  limitedBy: OperatingPointLimit;
}

export type OperatingPointLimit =
  "schedule" | "charger" | "vehicle" | "suspended" | "none";

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

/**
 * The charger side: what the hardware can deliver on this connector (#327).
 * Immutable at run time (blueprint, `cp.create`); `Infinity` when unknown.
 */
export interface ChargerTerm {
  /** Delivery cap in watts, `Infinity` when none is declared. */
  maxDeliveryW: number;
}

/** The charger term for a declared cap in watts (`undefined`: none). */
export function chargerTermOf(
  maxDeliveryPowerW: number | undefined,
): ChargerTerm {
  return {
    maxDeliveryW:
      maxDeliveryPowerW !== undefined &&
      Number.isFinite(maxDeliveryPowerW) &&
      maxDeliveryPowerW > 0
        ? maxDeliveryPowerW
        : Infinity,
  };
}

/** What can pause or zero the offer. */
export interface FaultTerm {
  /**
   * The EVSE is energizing the connector: a running transaction in `Charging`
   * or `SuspendedEV`. `SuspendedEVSE` (the EVSE withholds energy) and every
   * state before or after the session offer nothing. In `SuspendedEV` the EVSE
   * still offers energy and the vehicle takes none (OCPP 1.6 §7.7, 2.0.1
   * ChargingStateEnumType), which is why `Power.Offered` (1.6 §7.31, 2.0.1
   * §3.50) reads the offer there and `Power.Active.Import` reads 0.
   */
  offering: boolean;
  /** `SuspendedEV`: the register ticks but the offer is withheld. */
  energyOfferSuspended: boolean;
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
  charger: ChargerTerm;
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
  const { at, schedule, vehicle, session, charger, fault } = inputs;
  const { scheduleLimitW, activePhases } = schedule;
  const chargerCapW = charger.maxDeliveryW;
  // The one narrowing of the CSMS allocation by the hardware: every term
  // below (acceptance, offer, register bound, report bound) reads it, so a
  // cap cannot bind one and not another.
  const boundW = Math.min(scheduleLimitW, chargerCapW);
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
        scheduleLimitWatts: boundW,
      })
    : 0;
  // The curve describes battery acceptance, not EVSE capability: a 100 kW
  // charger still offers 100 kW to a nearly full battery (#301).
  const offeredW = fault.offering
    ? effectiveChargingPowerW({
        evMaxW,
        curve: undefined,
        socPercent: null,
        scheduleLimitWatts: boundW,
      })
    : 0;

  let accumulationCapW: number;
  if (fault.energyOfferSuspended) {
    accumulationCapW = 0;
  } else if (!curve || curve.length === 0 || !Number.isFinite(evMaxW)) {
    accumulationCapW = boundW;
  } else {
    accumulationCapW = effectiveChargingPowerW({
      evMaxW,
      curve,
      socPercent: curveSoc,
      scheduleLimitWatts: boundW,
    });
  }

  return {
    at,
    scheduleLimitW,
    chargerCapW,
    boundW,
    activePhases,
    acceptedW,
    offeredW,
    currentA: currentAmpsFor(acceptedW, electrical, activePhases),
    offeredCurrentA: currentAmpsFor(offeredW, electrical, activePhases),
    limitA: currentAmpsFor(boundW, electrical, activePhases),
    voltageV: effectiveVoltageV(electrical),
    powerFactor: effectivePowerFactor(electrical),
    soc: inputs.soc,
    accumulationCapW,
    limitedBy: limitedByOf(
      fault.energyOfferSuspended,
      scheduleLimitW,
      chargerCapW,
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
  chargerCapW: number,
  vehicleW: number,
  evMaxW: number,
): OperatingPointLimit {
  if (suspended) return "suspended";
  const capW = Math.min(scheduleLimitW, chargerCapW);
  // Equal limits are attributed to the CSMS allocation: it is the term a
  // user can change at run time.
  const capBy = chargerCapW < scheduleLimitW ? "charger" : "schedule";
  if (Number.isFinite(evMaxW)) return capW < vehicleW ? capBy : "vehicle";
  return Number.isFinite(capW) ? capBy : "none";
}
