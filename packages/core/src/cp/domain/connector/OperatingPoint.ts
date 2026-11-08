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
   */
  accumulationCapW: number;
}

export interface OperatingPointInputs {
  charging: boolean;
  settings: EVSettings | undefined;
  soc: number | null;
  transactionInitialSoc: number | undefined;
  scheduleLimitW: number;
  activePhases: number;
  energyOfferSuspended: boolean;
}

/** Resolve every physical quantity for one instant from already-resolved
 *  schedule constraints and the connector's vehicle state. Pure. */
export function resolveOperatingPoint(
  inputs: OperatingPointInputs,
): OperatingPoint {
  const { settings, scheduleLimitW, activePhases } = inputs;
  const electrical = settings ?? {};
  const maxKw = settings?.maxChargingPowerKw ?? 0;
  const evMaxW = maxKw > 0 ? maxKw * 1000 : Infinity;
  const curve = settings?.chargingCurve;
  const curveSoc = resolveSocForCurve(
    inputs.soc,
    inputs.transactionInitialSoc,
    settings?.initialSoc,
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
        socPercent: inputs.soc,
        scheduleLimitWatts: scheduleLimitW,
      })
    : 0;

  let accumulationCapW: number;
  if (inputs.energyOfferSuspended) {
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
  };
}
