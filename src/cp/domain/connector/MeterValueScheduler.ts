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
    };

interface MeterValueSchedulerCallbacks {
  getCurrentValue(): number;
  updateValue(value: number): void;
  onSend(connectorId: number): void;
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
      `[MeterValueScheduler] Starting increment strategy for connector ${this.connectorId} interval=${intervalMs}ms increment=${strategy.incrementValue} maxTime=${strategy.maxTimeSeconds || 'unlimited'} maxValue=${strategy.maxValue || 'unlimited'}`,
    );

    this.startTimestamp = Date.now();
    this.timer = setInterval(() => {
      this.tickIncrement(strategy);
    }, intervalMs);
  }

  private tickIncrement(strategy: Extract<MeterValueStrategy, { kind: "increment" }>): void {
    // Check max time
    if (strategy.maxTimeSeconds && strategy.maxTimeSeconds > 0 && this.startTimestamp) {
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
    if (strategy.maxValue && strategy.maxValue > 0 && current >= strategy.maxValue) {
      this.logger?.info?.(
        `[MeterValueScheduler] Max value reached (${strategy.maxValue}Wh) for connector ${this.connectorId}, stopping`,
      );
      this.stop();
      return;
    }

    const next = current + strategy.incrementValue;

    // Cap at maxValue if specified
    const finalValue = strategy.maxValue && strategy.maxValue > 0
      ? Math.min(next, strategy.maxValue)
      : next;

    this.callbacks.updateValue(finalValue);
    this.callbacks.onSend(this.connectorId);
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
    const elapsedMinutes = elapsedMs / 1000 / 60;
    const newValueKWh = getMeterValueAtTime(elapsedMinutes, config);
    const newValueWh = Math.round(newValueKWh * 1000);

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
