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

  constructor(
    private readonly connectorId: number,
    private readonly callbacks: MeterValueSchedulerCallbacks,
    private readonly logger?: Logger,
  ) {}

  start(strategy: MeterValueStrategy): void {
    this.stop();
    this.strategy = strategy;

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

    const next = current + effectiveIncrement;

    // Cap at maxValue if specified
    const finalValue =
      strategy.maxValue && strategy.maxValue > 0
        ? Math.min(next, strategy.maxValue)
        : next;

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
    const newValueKWh = getMeterValueAtTime(elapsedSeconds, config);
    let newValueWh = Math.round(newValueKWh * 1000);

    // Apply the OCPP charging profile cap by clamping the per-tick delta. The
    // bezier curve dictates an "ideal" trajectory; if the schedule says we
    // can only deliver P watts right now, the actual delta must not exceed
    // P × interval / 3600 Wh.
    const cap = this.callbacks.getScheduleLimitWatts?.() ?? Infinity;
    if (cap !== Infinity) {
      const intervalSec = config.autoCalculateInterval
        ? this.calculateAutoInterval(config) / 1000
        : Math.max(1, config.intervalSeconds);
      const current = this.callbacks.getCurrentValue();
      const maxIncrement = Math.max(0, (cap * intervalSec) / 3600);
      const clampedNext =
        current + Math.min(newValueWh - current, maxIncrement);
      newValueWh = Math.max(current, Math.round(clampedNext));
    }

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
