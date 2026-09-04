import {
  AutoTrafficPlanner,
  emptyAutoTrafficCounters,
  type AutoTrafficConfig,
  type AutoTrafficCounters,
} from "../../domain/connector/AutoTraffic";

export interface AutoTrafficHooks {
  /** Authorize a tag; resolve `false` when the CSMS refused. */
  authorize: (connectorId: number) => Promise<boolean>;
  startTransaction: (connectorId: number) => Promise<void>;
  stopTransaction: (connectorId: number) => Promise<void>;
  /** Whether a scenario currently owns this connector. */
  scenarioActive: (connectorId: number) => boolean;
  log: (message: string) => void;
}

/**
 * Drives background charging traffic on one connector (#300).
 *
 * The loop is: wait a drawn gap, roll `probabilityOfStart`, optionally
 * Authorize, start a session, wait a drawn duration, stop, repeat.
 *
 * **A scenario taking control suspends it.** A run's verdict must never depend
 * on whether background traffic happened to fire mid-run, so an attempt is
 * skipped entirely while `scenarioActive` is true rather than queued — queuing
 * would make the traffic burst the moment the scenario ended, which is exactly
 * the interference the rule exists to prevent.
 */
export class AutoTrafficRunner {
  private planner: AutoTrafficPlanner;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private startedAtMs = 0;
  readonly counters: AutoTrafficCounters = emptyAutoTrafficCounters();

  constructor(
    private config: AutoTrafficConfig,
    private readonly cpId: string,
    private readonly connectorId: number,
    private readonly hooks: AutoTrafficHooks,
  ) {
    this.planner = new AutoTrafficPlanner(config, cpId, connectorId);
  }

  start(): void {
    if (this.timer || !this.config.enabled) return;
    this.stopped = false;
    this.startedAtMs = Date.now();
    this.hooks.log(
      `[auto-traffic] ${this.cpId}/${this.connectorId} started (seed ${this.config.seed})`,
    );
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Replace the config. Restarts the stream, so the seed takes effect. */
  reconfigure(config: AutoTrafficConfig): void {
    this.stop();
    this.config = config;
    this.planner = new AutoTrafficPlanner(config, this.cpId, this.connectorId);
    if (config.enabled) this.start();
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const step = this.planner.next();
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.runStep(step.start, step.durationSec);
      },
      Math.max(0, step.gapSec * 1000),
    );
  }

  private expired(): boolean {
    if (this.config.stopAfterSec === undefined) return false;
    return Date.now() - this.startedAtMs >= this.config.stopAfterSec * 1000;
  }

  private async runStep(start: boolean, durationSec: number): Promise<void> {
    if (this.stopped) return;
    if (this.expired()) {
      this.hooks.log(
        `[auto-traffic] ${this.cpId}/${this.connectorId} stopped (stopAfterSec reached)`,
      );
      this.stop();
      return;
    }
    // A scenario owns the connector: skip this attempt rather than queue it.
    if (this.hooks.scenarioActive(this.connectorId)) {
      this.scheduleNext();
      return;
    }

    this.counters.attempted++;
    if (!start) {
      this.counters.skipped++;
      this.scheduleNext();
      return;
    }

    try {
      if (this.config.requireAuthorize) {
        const accepted = await this.hooks.authorize(this.connectorId);
        if (!accepted) {
          this.counters.rejected++;
          this.scheduleNext();
          return;
        }
      }
      await this.hooks.startTransaction(this.connectorId);
      this.counters.started++;
    } catch (err) {
      // A failed start is not a reason to stop generating: the CSMS being
      // unreachable for one attempt is exactly the condition a load run is
      // there to survive.
      this.counters.rejected++;
      this.hooks.log(
        `[auto-traffic] ${this.cpId}/${this.connectorId} start failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.scheduleNext();
      return;
    }

    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.endSession();
      },
      Math.max(0, durationSec * 1000),
    );
  }

  private async endSession(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.hooks.stopTransaction(this.connectorId);
      this.counters.completed++;
    } catch (err) {
      this.hooks.log(
        `[auto-traffic] ${this.cpId}/${this.connectorId} stop failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.scheduleNext();
  }
}
