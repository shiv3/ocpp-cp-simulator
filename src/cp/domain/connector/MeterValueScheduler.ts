import type { Logger } from "../../shared/Logger";
import {
  type AutoMeterValueConfig,
  getMeterValueAtTime,
} from "./MeterValueCurve";

export type MeterValueStrategy =
  | {
      kind: "curve";
      config: AutoMeterValueConfig;
      maxTimeSeconds?: number; // Maximum time to run (0 = unlimited)
      maxValue?: number; // Maximum meter value in Wh (0 = unlimited)
    }
  | {
      kind: "increment";
      intervalSeconds: number;
      incrementValue: number;
      maxTimeSeconds?: number; // Maximum time to run (0 = unlimited)
      maxValue?: number; // Maximum meter value in Wh (0 = unlimited)
      sendMeterValues?: boolean; // false = update local register only
    };

interface MeterValueSchedulerCallbacks {
  getCurrentValue(): number;
  updateValue(value: number): void;
  onSend(connectorId: number): void;
  /**
   * Optional cap (in watts) the active OCPP charging profile imposes at the
   * current instant. Recomputed every tick so a Recurring/Absolute schedule
   * that changes period mid-transaction is respected. Return `Infinity` for
   * "uncapped" (no profile active). Return `0` to pause delivery (the
   * connector will continue ticking but won't add energy — the surrounding
   * domain handles the SuspendedEVSE transition).
   */
  getScheduleLimitWatts?(): number;
}

export class MeterValueScheduler {
  private timer: NodeJS.Timeout | null = null;
  private startTimestamp: number | null = null;
  private strategy: MeterValueStrategy | null = null;

  /**
   * Sub-watt-hour energy delivered but not yet representable in the register,
   * carried from one tick to the next (#301).
   *
   * `Connector.applyMeterValue` rounds every value it is handed to an integer
   * watt-hour, because a fractional `meterStop` is rejected by a strict CSMS
   * with a FormationViolation, and it is that rounded value the next tick
   * reads back as "current". Without a carry the fraction is not deferred, it
   * is destroyed: a per-tick delta below 0.5 Wh rounds away every time and the
   * register never moves again. A charging curve tapering below 1800 W with a
   * 1-second interval delivers under 0.5 Wh per tick, so this is reachable
   * with ordinary settings — the meter and the SoC would freeze while
   * `Power.Active.Import` still reported real power.
   *
   * Always in `[-0.5, 0.5)`, being `raw − round(raw)`, so the register it
   * feeds tracks the true delivered energy to within half a watt-hour no
   * matter how many ticks pass. Reset whenever the scheduler starts or stops:
   * a new session starts from a whole watt-hour.
   */
  private carryWh = 0;

  /**
   * The energy register at the instant the curve strategy started — the
   * baseline its trajectory is added to (#301).
   *
   * `getMeterValueAtTime` returns an absolute value on a curve that starts at
   * zero, while `Energy.Active.Import.Register` is cumulative across the whole
   * life of the connector: OCPP never resets it, and `StartTransaction`
   * records `meterStart` as whatever it already reads. Treating the curve's
   * output as the register itself was therefore only ever right for a
   * connector's *first* session. On the second, the uncapped branch assigned a
   * value below `meterStart` — a register running backwards, which no meter
   * does and which makes `meterStop < meterStart` — and the capped branch saw
   * a negative delta, clamped it away and froze delivery until the curve
   * climbed back past the old register, or forever once the register passed
   * the curve's maximum.
   *
   * With the baseline, the curve means "energy delivered in this session",
   * which is what `meterStop − meterStart` already means. A session that
   * starts from an empty register is unchanged, since the baseline is then 0.
   */
  private curveBaselineWh = 0;

  constructor(
    private readonly connectorId: number,
    private readonly callbacks: MeterValueSchedulerCallbacks,
    private readonly logger?: Logger,
  ) {}

  start(strategy: MeterValueStrategy): void {
    this.stop();
    this.strategy = strategy;
    this.carryWh = 0;
    // Captured before the first tick: the curve describes this session's
    // delivery, added on top of whatever the cumulative register already
    // reads (#301).
    this.curveBaselineWh =
      strategy.kind === "curve" ? this.callbacks.getCurrentValue() : 0;

    if (strategy.kind === "curve") {
      const { config } = strategy;
      if (!config.enabled) {
        this.logger?.info?.(
          `[MeterValueScheduler] Curve strategy disabled for connector ${this.connectorId}`,
        );
        return;
      }

      this.startTimestamp = Date.now();
      const intervalMs = config.autoCalculateInterval
        ? this.calculateAutoInterval(config)
        : Math.max(1000, config.intervalSeconds * 1000);

      this.logger?.info?.(
        `[MeterValueScheduler] Starting curve strategy for connector ${this.connectorId} interval=${intervalMs}ms`,
      );

      this.timer = setInterval(() => {
        this.tickCurve(config);
      }, intervalMs);
      return;
    }

    const intervalMs = Math.max(1000, strategy.intervalSeconds * 1000);
    this.logger?.info?.(
      `[MeterValueScheduler] Starting increment strategy for connector ${this.connectorId} interval=${intervalMs}ms increment=${strategy.incrementValue} maxTime=${strategy.maxTimeSeconds || "unlimited"} maxValue=${strategy.maxValue || "unlimited"}`,
    );

    this.startTimestamp = Date.now();
    this.timer = setInterval(() => {
      this.tickIncrement(strategy);
    }, intervalMs);
  }

  private tickIncrement(
    strategy: Extract<MeterValueStrategy, { kind: "increment" }>,
  ): void {
    // Check max time
    if (
      strategy.maxTimeSeconds &&
      strategy.maxTimeSeconds > 0 &&
      this.startTimestamp
    ) {
      const elapsedSeconds = (Date.now() - this.startTimestamp) / 1000;
      if (elapsedSeconds >= strategy.maxTimeSeconds) {
        this.logger?.info?.(
          `[MeterValueScheduler] Max time reached (${strategy.maxTimeSeconds}s) for connector ${this.connectorId}, stopping`,
        );
        this.stop();
        return;
      }
    }

    const current = this.callbacks.getCurrentValue();

    // Check max value before incrementing
    if (
      strategy.maxValue &&
      strategy.maxValue > 0 &&
      current >= strategy.maxValue
    ) {
      this.logger?.info?.(
        `[MeterValueScheduler] Max value reached (${strategy.maxValue}Wh) for connector ${this.connectorId}, stopping`,
      );
      this.stop();
      return;
    }

    // Apply the OCPP charging profile limit (§5.16 / §5.10) as a per-tick
    // cap. Configured increment is what the scenario WOULD draw; the schedule
    // throttles down to whatever the profile allows right now. limit=0 means
    // paused (we still tick so a later period can resume delivery).
    const cap = this.callbacks.getScheduleLimitWatts?.() ?? Infinity;
    let effectiveIncrement = strategy.incrementValue;
    if (cap !== Infinity) {
      const allowedIncrementWh = (cap * strategy.intervalSeconds) / 3600; // P×t → energy (Wh)
      effectiveIncrement = Math.min(
        strategy.incrementValue,
        allowedIncrementWh,
      );
      if (effectiveIncrement < 0) effectiveIncrement = 0;
    }

    // `current` is the rounded register; `carryWh` is the fraction the last
    // rounding could not represent. Adding it back before rounding again is
    // what lets an increment smaller than 0.5 Wh — a curve-throttled tick on a
    // 1-second interval — still move the register, every other tick or every
    // fourth, instead of never (#301).
    const raw = current + this.carryWh + effectiveIncrement;

    // Cap at maxValue if specified
    const cappedRaw =
      strategy.maxValue && strategy.maxValue > 0
        ? Math.min(raw, strategy.maxValue)
        : raw;
    const finalValue = Math.round(cappedRaw);
    this.carryWh = cappedRaw - finalValue;

    this.callbacks.updateValue(finalValue);
    if (strategy.sendMeterValues !== false) {
      this.callbacks.onSend(this.connectorId);
    }

    if (
      strategy.maxValue &&
      strategy.maxValue > 0 &&
      finalValue >= strategy.maxValue
    ) {
      this.logger?.info?.(
        `[MeterValueScheduler] Max value reached (${strategy.maxValue}Wh) for connector ${this.connectorId}, stopping`,
      );
      this.stop();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.startTimestamp = null;
    this.strategy = null;
    this.carryWh = 0;
    this.curveBaselineWh = 0;
  }

  isActive(): boolean {
    return this.timer !== null;
  }

  cleanup(): void {
    this.stop();
  }

  private tickCurve(config: AutoMeterValueConfig): void {
    if (!this.startTimestamp) return;

    const elapsedMs = Date.now() - this.startTimestamp;
    const elapsedSeconds = elapsedMs / 1000;
    // The trajectory this session delivers, on top of the register it started
    // from. Without the baseline this is an absolute value, which rewinds a
    // cumulative register on every session after the first (#301).
    const idealWh =
      this.curveBaselineWh + getMeterValueAtTime(elapsedSeconds, config) * 1000;
    let rawNext = idealWh;

    // Apply the OCPP charging profile cap by clamping the per-tick delta. The
    // bezier curve dictates an "ideal" trajectory; if the schedule says we
    // can only deliver P watts right now, the actual delta must not exceed
    // P × interval / 3600 Wh.
    const cap = this.callbacks.getScheduleLimitWatts?.() ?? Infinity;
    if (cap !== Infinity) {
      const intervalSec = config.autoCalculateInterval
        ? this.calculateAutoInterval(config) / 1000
        : Math.max(1, config.intervalSeconds);
      // The register plus the fraction the last rounding dropped: the energy
      // actually delivered so far. Clamping against the rounded register alone
      // would discard every capped delta below 0.5 Wh instead of deferring it,
      // freezing the meter under a low cap (#301).
      const delivered = this.callbacks.getCurrentValue() + this.carryWh;
      const maxIncrement = Math.max(0, (cap * intervalSec) / 3600);
      rawNext = delivered + Math.min(idealWh - delivered, maxIncrement);
      rawNext = Math.max(delivered, rawNext);
    }

    const newValueWh = Math.round(rawNext);
    this.carryWh = rawNext - newValueWh;

    this.callbacks.updateValue(newValueWh);
    this.callbacks.onSend(this.connectorId);
  }

  private calculateAutoInterval(config: AutoMeterValueConfig): number {
    const points = [...config.curvePoints].sort((a, b) => a.time - b.time);
    if (points.length < 2) {
      return 10 * 1000; // default 10s
    }

    const durationMinutes =
      points[points.length - 1].time - points[0].time || 1;

    const intervalSeconds = Math.max(
      5,
      Math.min(60, (durationMinutes * 60) / 100),
    );

    return intervalSeconds * 1000;
  }
}
