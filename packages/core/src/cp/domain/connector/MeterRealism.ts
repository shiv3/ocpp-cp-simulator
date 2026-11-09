/**
 * Opt-in realism of one connector's meter (#614, #615, #616): seeded
 * fluctuation, power ramp-up, per-phase detail, an export (V2X) term and the
 * SampledValue shape. Plain JSON, carried in `chargerCapabilities` (the
 * hardware side) next to the delivery cap of #327. Absent means the
 * historical output, byte for byte.
 *
 * Protocol-agnostic: imports nothing from `ocpp/` or a transport.
 */

/** Percent fluctuation of the three electrical quantities (#614). Each is the
 *  half-width of a uniform band around the nominal value; 0 or absent keeps
 *  the quantity constant. */
export interface FluctuationConfig {
  voltagePct?: number;
  /** Extra jitter on the current as a meter reads it; the load itself moves
   *  with `powerPct`, and the current follows the load. */
  currentPct?: number;
  powerPct?: number;
}

export type RampShape = "linear" | "sigmoid";

/** Power ramp-up from a session's start (#614). */
export interface RampUpConfig {
  shape: RampShape;
  /** Seconds from 0 to the full power. */
  durationSeconds: number;
}

/** Per-phase detail of a 3-phase connector (#615): its presence turns on
 *  L1-N / L2-N / L3-N (and, with `lineToLine`, L1-L2 / L2-L3 / L3-L1)
 *  Voltage samples and independent per-phase Current.Import and
 *  Power.Active.Import. */
export interface PhaseDetailConfig {
  /** Half-width in percent of the per-phase voltage deviation. Default 0. */
  voltageImbalancePct?: number;
  /** Half-width in percent of the per-phase load deviation. The phase
   *  powers always add up to the connector power. Default 0. */
  loadImbalancePct?: number;
  /** Also emit the line-to-line voltages. Default true. */
  lineToLine?: boolean;
}

/** A discharge (V2X) term (#615): while the connector is `Charging` it
 *  exports this power (capped by the charger and the vehicle) instead of
 *  importing, which is what the Export measurands report. */
export interface ExportConfig {
  powerW: number;
}

/** What to change on a matched sample (#616). */
export interface SampledValueSet {
  /** Reported unit. Within a family (Wh/kWh, W/kW, varh/kvarh, var/kvar,
   *  VA/kVA, Celsius/Fahrenheit/K) the value is converted; otherwise only
   *  the label changes. */
  unit?: string;
  /** Power of ten of the reported value (2.0.1 `unitOfMeasure.multiplier`):
   *  the actual value is `value × 10^multiplier`. Sent on OCPP 2.x only. */
  multiplier?: number;
  /** Decimals of a converted value. Default 3. */
  decimals?: number;
  location?: string;
  context?: string;
  phase?: string;
  /** Fixed value, as sent. Wins over conversion. */
  value?: string;
  /** Drop the sample. */
  omit?: boolean;
}

export interface SampledValueOverride {
  /** Matches samples of this measurand. */
  measurand: string;
  /** Match only this phase; absent matches every sample of the measurand. */
  phase?: string;
  set: SampledValueSet;
}

export interface MeterRealism {
  /** Seed of every random draw below; 0 when absent. */
  seed?: number;
  fluctuation?: FluctuationConfig;
  rampUp?: RampUpConfig;
  phases?: PhaseDetailConfig;
  export?: ExportConfig;
  sampledValues?: SampledValueOverride[];
}

/** The station's main meter on connector 0 / EVSE 0 (#617). */
export interface MainMeterConfig {
  /** Constant station consumption in watts (auxiliaries). Default 0. */
  baseLoadW?: number;
  /** Grid voltage, phase to neutral. Default 230. */
  voltageV?: number;
  /** Phases of the grid connection. Default 3. */
  phases?: 1 | 3;
  seed?: number;
  /** Fluctuation of the grid voltage only. */
  voltagePct?: number;
  sampledValues?: SampledValueOverride[];
}

/** Uniform draw in [-1, 1) keyed by seed, instant bucket and channel: pure,
 *  so the same seed gives the same series at the same instants. */
export function seededUnit(
  seed: number,
  bucket: number,
  channel: number,
): number {
  let h =
    (Math.imul(seed | 0, 0x9e3779b1) ^
      Math.imul(bucket | 0, 0x85ebca6b) ^
      Math.imul(channel | 0, 0xc2b2ae35)) >>>
    0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h / 0x100000000) * 2 - 1;
}

/** Instants are bucketed to whole seconds so the quantities a sample set
 *  reads, and the register tick of the same second, share one draw. */
export function secondBucket(atMs: number): number {
  return Math.floor(atMs / 1000);
}

/** Fraction of full power `elapsedMs` into a ramp, in [0, 1]. */
export function rampFactor(ramp: RampUpConfig, elapsedMs: number): number {
  const duration = ramp.durationSeconds * 1000;
  if (!(duration > 0)) return 1;
  const t = Math.min(1, Math.max(0, elapsedMs / duration));
  if (ramp.shape === "linear") return t;
  const logistic = (x: number) => 1 / (1 + Math.exp(-12 * (x - 0.5)));
  const lo = logistic(0);
  return (logistic(t) - lo) / (logistic(1) - lo);
}

const UNIT_FAMILIES: ReadonlyArray<Record<string, number>> = [
  { Wh: 1, kWh: 1000 },
  { W: 1, kW: 1000 },
  { varh: 1, kvarh: 1000 },
  { var: 1, kvar: 1000 },
  { VA: 1, kVA: 1000 },
];

/** `value` expressed in `from` converted to `to`; `null` when the units are
 *  not in one family. */
export function convertUnit(
  value: number,
  from: string,
  to: string,
): number | null {
  if (from === to) return value;
  for (const family of UNIT_FAMILIES) {
    if (from in family && to in family)
      return (value * family[from]) / family[to];
  }
  const temp = (u: string) =>
    u === "Celsius" || u === "Fahrenheit" || u === "K";
  if (temp(from) && temp(to)) {
    const celsius =
      from === "Celsius"
        ? value
        : from === "K"
          ? value - 273.15
          : ((value - 32) * 5) / 9;
    return to === "Celsius"
      ? celsius
      : to === "K"
        ? celsius + 273.15
        : (celsius * 9) / 5 + 32;
  }
  return null;
}

const MEASURAND_RE = /^[A-Za-z][A-Za-z.]*$/;

function pct(value: unknown, label: string): string | null {
  if (value === undefined) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 50
  ) {
    return `${label} must be a number from 0 to 50`;
  }
  return null;
}

function overridesProblem(list: unknown, label: string): string | null {
  if (list === undefined) return null;
  if (!Array.isArray(list)) return `${label} must be an array`;
  for (const rule of list) {
    if (typeof rule !== "object" || rule === null) {
      return `${label} entries must be objects`;
    }
    const { measurand, phase, set } = rule as Record<string, unknown>;
    if (typeof measurand !== "string" || !MEASURAND_RE.test(measurand)) {
      return `${label} measurand must be an OCPP measurand name`;
    }
    if (phase !== undefined && typeof phase !== "string") {
      return `${label} phase must be a string`;
    }
    if (typeof set !== "object" || set === null) {
      return `${label} entries need a set object`;
    }
    const s = set as Record<string, unknown>;
    for (const key of ["unit", "location", "context", "phase", "value"]) {
      if (s[key] !== undefined && typeof s[key] !== "string") {
        return `${label} set.${key} must be a string`;
      }
    }
    if (
      s.multiplier !== undefined &&
      (typeof s.multiplier !== "number" || !Number.isInteger(s.multiplier))
    ) {
      return `${label} set.multiplier must be an integer`;
    }
    if (
      s.decimals !== undefined &&
      (typeof s.decimals !== "number" ||
        !Number.isInteger(s.decimals) ||
        s.decimals < 0 ||
        s.decimals > 10)
    ) {
      return `${label} set.decimals must be an integer from 0 to 10`;
    }
    if (s.omit !== undefined && typeof s.omit !== "boolean") {
      return `${label} set.omit must be a boolean`;
    }
  }
  return null;
}

/** Why `value` is not a usable {@link MeterRealism}, or `null`. */
export function meterRealismProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "meter must be an object";
  }
  const m = value as Record<string, unknown>;
  if (
    m.seed !== undefined &&
    (typeof m.seed !== "number" || !Number.isInteger(m.seed))
  ) {
    return "meter.seed must be an integer";
  }
  if (m.fluctuation !== undefined) {
    const f = m.fluctuation as Record<string, unknown> | null;
    if (typeof f !== "object" || f === null)
      return "meter.fluctuation must be an object";
    for (const key of ["voltagePct", "currentPct", "powerPct"]) {
      const bad = pct(f[key], `meter.fluctuation.${key}`);
      if (bad) return bad;
    }
  }
  if (m.rampUp !== undefined) {
    const r = m.rampUp as Record<string, unknown> | null;
    if (typeof r !== "object" || r === null)
      return "meter.rampUp must be an object";
    if (r.shape !== "linear" && r.shape !== "sigmoid") {
      return "meter.rampUp.shape must be linear or sigmoid";
    }
    if (
      typeof r.durationSeconds !== "number" ||
      !(r.durationSeconds > 0) ||
      !Number.isFinite(r.durationSeconds)
    ) {
      return "meter.rampUp.durationSeconds must be a positive number";
    }
  }
  if (m.phases !== undefined) {
    const p = m.phases as Record<string, unknown> | null;
    if (typeof p !== "object" || p === null)
      return "meter.phases must be an object";
    for (const key of ["voltageImbalancePct", "loadImbalancePct"]) {
      const bad = pct(p[key], `meter.phases.${key}`);
      if (bad) return bad;
    }
    if (p.lineToLine !== undefined && typeof p.lineToLine !== "boolean") {
      return "meter.phases.lineToLine must be a boolean";
    }
  }
  if (m.export !== undefined) {
    const e = m.export as Record<string, unknown> | null;
    if (typeof e !== "object" || e === null)
      return "meter.export must be an object";
    if (
      typeof e.powerW !== "number" ||
      !(e.powerW > 0) ||
      !Number.isFinite(e.powerW)
    ) {
      return "meter.export.powerW must be a positive number of watts";
    }
  }
  return overridesProblem(m.sampledValues, "meter.sampledValues");
}

/** Why `value` is not a usable {@link MainMeterConfig}, or `null`. */
export function mainMeterProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "mainMeter must be an object";
  }
  const m = value as Record<string, unknown>;
  if (
    m.baseLoadW !== undefined &&
    (typeof m.baseLoadW !== "number" ||
      !Number.isFinite(m.baseLoadW) ||
      m.baseLoadW < 0)
  ) {
    return "mainMeter.baseLoadW must be a non-negative number of watts";
  }
  if (
    m.voltageV !== undefined &&
    (typeof m.voltageV !== "number" ||
      !Number.isFinite(m.voltageV) ||
      m.voltageV <= 0)
  ) {
    return "mainMeter.voltageV must be a positive number";
  }
  if (m.phases !== undefined && m.phases !== 1 && m.phases !== 3) {
    return "mainMeter.phases must be 1 or 3";
  }
  if (
    m.seed !== undefined &&
    (typeof m.seed !== "number" || !Number.isInteger(m.seed))
  ) {
    return "mainMeter.seed must be an integer";
  }
  const bad = pct(m.voltagePct, "mainMeter.voltagePct");
  if (bad) return bad;
  return overridesProblem(m.sampledValues, "mainMeter.sampledValues");
}
