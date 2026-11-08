import {
  currentAmpsFor,
  effectiveChargingPowerW,
  effectivePowerFactor,
  effectiveVoltageV,
  resolveSocForCurve,
} from "./ChargingCurve";
import type { EVSettings } from "./EVSettings";
import {
  rampFactor,
  secondBucket,
  seededUnit,
  type MeterRealism,
} from "./MeterRealism";

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
  /**
   * Multiplier the opt-in meter realism applied to the accepted power
   * (power ramp-up × seeded power fluctuation, #614); exactly 1 when neither
   * is configured. The register tick scales a configured increment by it, so
   * the energy it adds is the integral of the power that is reported.
   */
  deliveryFactor: number;
  /** Power the connector exports (V2X, #615) in watts; 0 unless a discharge
   *  term is configured and the connector is `Charging`. */
  exportW: number;
  /** Line current for {@link exportW}. */
  exportCurrentA: number;
  /** Independent per-phase quantities (#615); `null` unless configured and
   *  all three phases are in use. */
  phaseDetail: PhaseDetail | null;
}

/** Per-phase quantities of a 3-phase connector, resolved with the point. */
export interface PhaseDetail {
  /** L1-N, L2-N, L3-N volts. */
  voltageV: [number, number, number];
  /** L1-L2, L2-L3, L3-L1 volts. */
  lineToLineV: [number, number, number];
  /** Current of each phase for its share of {@link OperatingPoint.acceptedW}. */
  currentA: [number, number, number];
  /** Active power of each phase; adds up to `acceptedW`. */
  powerW: [number, number, number];
  /** Whether the line-to-line voltages are reported. */
  lineToLine: boolean;
}

/** The opt-in meter realism of one resolve (#614, #615). */
export interface MeterTerm {
  /** `undefined`: the historical, constant output. */
  realism?: MeterRealism;
  /** Epoch ms the running transaction started, for the ramp-up; `undefined`
   *  outside a transaction (no ramp). */
  sessionStartedAt?: number;
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
  charger: ChargerTerm;
  fault: FaultTerm;
  /** `{}` for a connector without meter realism. */
  meter: MeterTerm;
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
  const { at, schedule, vehicle, session, charger, fault, meter } = inputs;
  const { scheduleLimitW, activePhases } = schedule;
  const chargerCapW = charger.maxDeliveryW;
  // The one narrowing of the CSMS allocation by the hardware: every term
  // below (acceptance, offer, register bound, report bound) reads it, so a
  // cap cannot bind one and not another.
  const boundW = Math.min(scheduleLimitW, chargerCapW);
  const { maxW: evMaxW, curve } = vehicle;
  const realism = meter.realism;
  const seed = realism?.seed ?? 0;
  const bucket = secondBucket(at);
  const draw = (channel: number, halfWidthPct: number | undefined): number =>
    halfWidthPct
      ? 1 + (halfWidthPct / 100) * seededUnit(seed, bucket, channel)
      : 1;
  // The voltage that produces every current below: fluctuated once here, so
  // the sample set and the register read the same value (#614).
  const voltageFactor = draw(1, realism?.fluctuation?.voltagePct);
  const electrical: Partial<EVSettings> =
    voltageFactor === 1
      ? vehicle.electrical
      : {
          ...vehicle.electrical,
          voltageV: effectiveVoltageV(vehicle.electrical) * voltageFactor,
        };
  const ramp =
    realism?.rampUp && meter.sessionStartedAt !== undefined
      ? rampFactor(realism.rampUp, at - meter.sessionStartedAt)
      : 1;
  const deliveryFactor = ramp * draw(2, realism?.fluctuation?.powerPct);
  const exportConfigW = realism?.export?.powerW ?? 0;
  const exporting = inputs.charging && exportConfigW > 0;
  const curveSoc = resolveSocForCurve(
    inputs.soc,
    session.initialSoc,
    undefined,
  );

  const baseAcceptedW =
    inputs.charging && !exporting
      ? effectiveChargingPowerW({
          evMaxW,
          curve,
          socPercent: curveSoc,
          scheduleLimitWatts: boundW,
        })
      : 0;
  // Ramp and fluctuation never carry the report past the bound (the CSMS
  // allocation narrowed by the hardware) or the vehicle's own ceiling, so a
  // fluctuating load at full power dips below it and never rises above.
  const ceilingW = Math.min(boundW, evMaxW);
  const acceptedW =
    deliveryFactor === 1
      ? baseAcceptedW
      : Math.min(baseAcceptedW * deliveryFactor, ceilingW);
  const exportW = exporting ? Math.min(exportConfigW, chargerCapW, evMaxW) : 0;
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
  if (fault.energyOfferSuspended || fault.energyHeld || exporting) {
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
  if (deliveryFactor !== 1 && Number.isFinite(accumulationCapW)) {
    accumulationCapW = Math.min(accumulationCapW * deliveryFactor, ceilingW);
  }

  // Jitter of the current as a meter reads it, on top of the load (#614).
  const currentFactor = draw(3, realism?.fluctuation?.currentPct);

  return {
    at,
    scheduleLimitW,
    chargerCapW,
    boundW,
    activePhases,
    acceptedW,
    offeredW,
    currentA:
      currentAmpsFor(acceptedW, electrical, activePhases) * currentFactor,
    offeredCurrentA: currentAmpsFor(offeredW, electrical, activePhases),
    limitA: currentAmpsFor(boundW, electrical, activePhases),
    voltageV: effectiveVoltageV(electrical),
    powerFactor: effectivePowerFactor(electrical),
    soc: inputs.soc,
    deliveryFactor,
    exportW,
    exportCurrentA: currentAmpsFor(exportW, electrical, activePhases),
    phaseDetail: phaseDetailOf(
      realism,
      electrical,
      activePhases,
      acceptedW,
      seed,
      bucket,
    ),
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

/** The independent per-phase quantities (#615), or `null` when not
 *  configured or not all three phases are in use (the same rule as the
 *  per-phase samples: a subset of L1/L2/L3 would invent an allocation). */
function phaseDetailOf(
  realism: MeterRealism | undefined,
  electrical: Partial<EVSettings>,
  activePhases: number,
  acceptedW: number,
  seed: number,
  bucket: number,
): PhaseDetail | null {
  const config = realism?.phases;
  if (!config || activePhases !== 3 || electrical.currentType === "DC") {
    return null;
  }
  const nominalV = effectiveVoltageV(electrical);
  const powerFactor = effectivePowerFactor(electrical);
  const swing = (channel: number, halfWidthPct: number | undefined): number =>
    1 + ((halfWidthPct ?? 0) / 100) * seededUnit(seed, bucket, channel);
  const voltageV: [number, number, number] = [
    nominalV * swing(11, config.voltageImbalancePct),
    nominalV * swing(12, config.voltageImbalancePct),
    nominalV * swing(13, config.voltageImbalancePct),
  ];
  const weights = [
    swing(21, config.loadImbalancePct),
    swing(22, config.loadImbalancePct),
    swing(23, config.loadImbalancePct),
  ];
  const weightSum = weights[0] + weights[1] + weights[2];
  const powerW = weights.map((w) => (acceptedW * w) / weightSum) as [
    number,
    number,
    number,
  ];
  const currentA = powerW.map((p, i) =>
    p > 0 ? p / (voltageV[i] * powerFactor) : 0,
  ) as [number, number, number];
  // Phasors 120 degrees apart: |a - b|^2 = a^2 + b^2 + ab.
  const between = (a: number, b: number) => Math.sqrt(a * a + b * b + a * b);
  return {
    voltageV,
    lineToLineV: [
      between(voltageV[0], voltageV[1]),
      between(voltageV[1], voltageV[2]),
      between(voltageV[2], voltageV[0]),
    ],
    currentA,
    powerW,
    lineToLine: config.lineToLine !== false,
  };
}
