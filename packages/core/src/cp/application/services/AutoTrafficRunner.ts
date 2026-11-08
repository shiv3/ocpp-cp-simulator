import {
  AUTO_TRAFFIC_ID_TAG,
  AutoTrafficPlanner,
  emptyAutoTrafficCounters,
  type AutoTrafficConfig,
  type AutoTrafficCounters,
} from "../../domain/connector/AutoTraffic";
import { realClock } from "../../shared/clock";
import type { SimClock, TimerHandle } from "../../shared/clock";

/** How often a session whose time is up re-checks for power (#798). */
const POWER_RECHECK_MS = 1000;

export interface AutoTrafficHooks {
  /**
   * The idTag a session on this connector presents (#603). The runner asks
   * once per session, so Authorize and the start use the same tag. Absent:
   * {@link AUTO_TRAFFIC_ID_TAG}.
   */
  idTag?: (connectorId: number) => string;
  /**
   * Why a session cannot start now, or `null` when it can (#603): the charge
   * point is not Accepted, the connector is not Available, or a transaction
   * is active. Such a cycle counts as skipped.
   */
  startBlocker?: (connectorId: number) => string | null;
  /** Authorize a tag; resolve `false` when the CSMS refused. */
  authorize: (connectorId: number, idTag: string) => Promise<boolean>;
  /** Start a session; resolve `false` when it did not begin (#603). */
  startTransaction: (
    connectorId: number,
    idTag: string,
  ) => Promise<void | boolean>;
  stopTransaction: (connectorId: number) => Promise<void>;
  /**
   * Whether the station is without power (#798). A session whose duration
   * ends during an outage stays open: how a transaction interrupted by a
   * power loss ends is decided by the recovery after the restore, not by the
   * traffic timer.
   */
  poweredOff?: (connectorId: number) => boolean;
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
  private timer: TimerHandle | null = null;
  private stopped = false;
  /** Whether a session this runner started is still open. */
  private sessionOpen = false;
  /** The start conf of the open session was already counted as refused, so
   *  a later refusal in the same session corrects nothing (#603). */
  private startConfSettled = false;
  private startedAtMs = 0;
  readonly counters: AutoTrafficCounters = emptyAutoTrafficCounters();

  constructor(
    private config: AutoTrafficConfig,
    private readonly cpId: string,
    private readonly connectorId: number,
    private readonly hooks: AutoTrafficHooks,
    private readonly clock: SimClock = realClock,
  ) {
    this.planner = new AutoTrafficPlanner(config, cpId, connectorId);
  }

  start(): void {
    if (this.timer || !this.config.enabled) return;
    this.stopped = false;
    this.startedAtMs = this.clock.now();
    this.hooks.log(
      `[auto-traffic] ${this.cpId}/${this.connectorId} started (seed ${this.config.seed})`,
    );
    this.scheduleNext();
  }

  /**
   * Stop generating, and end a session this runner started.
   *
   * Clearing the duration timer alone left that transaction charging for as
   * long as the daemon lived — disabling traffic, reconfiguring it or deleting
   * the charge point would each have leaked one.
   */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.sessionOpen) {
      this.sessionOpen = false;
      void this.hooks.stopTransaction(this.connectorId).catch(() => undefined);
    }
  }

  /**
   * The CSMS answered this connector's StartTransaction with an idTagInfo that
   * is not Accepted (#603). The session was counted `startAccepted` when the
   * request went out; the conf corrects it to a refusal. `started` and
   * `completed` still count the session, which the station may leave running
   * (`StopTransactionOnInvalidId`).
   */
  noteStartConfRefused(): void {
    if (!this.sessionOpen || this.startConfSettled) return;
    this.startConfSettled = true;
    if (this.counters.startAccepted > 0) this.counters.startAccepted--;
    this.counters.startRejected++;
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
    this.timer = this.clock.setTimeout(
      () => {
        this.timer = null;
        void this.runStep(step.start, step.durationSec);
      },
      Math.max(0, step.gapSec * 1000),
    );
  }

  private expired(): boolean {
    const now = this.clock.now();
    if (
      this.config.stopAfterSec !== undefined &&
      now - this.startedAtMs >= this.config.stopAfterSec * 1000
    ) {
      return true;
    }
    // #603: the absolute stop time.
    return (
      this.config.stopAt !== undefined && now >= Date.parse(this.config.stopAt)
    );
  }

  /** A cycle that began no session (#603). */
  private skip(): void {
    this.counters.skipped++;
    this.counters.consecutiveSkips++;
    this.scheduleNext();
  }

  private lastSkipReason: string | null = null;

  private async runStep(start: boolean, durationSec: number): Promise<void> {
    if (this.stopped) return;
    if (this.expired()) {
      this.hooks.log(
        `[auto-traffic] ${this.cpId}/${this.connectorId} stopped (${this.config.stopAt !== undefined && this.clock.now() >= Date.parse(this.config.stopAt) ? "stopAt" : "stopAfterSec"} reached)`,
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
    const now = this.clock.now();
    this.counters.firstRunAt ??= now;
    this.counters.lastRunAt = now;
    if (!start) {
      this.skip();
      return;
    }
    const blocker = this.hooks.startBlocker?.(this.connectorId) ?? null;
    if (blocker !== null) {
      // Once per reason: a fleet with disconnected charge points would log
      // every cycle otherwise.
      if (blocker !== this.lastSkipReason) {
        this.lastSkipReason = blocker;
        this.hooks.log(
          `[auto-traffic] ${this.cpId}/${this.connectorId} cycle skipped: ${blocker}`,
        );
      }
      this.skip();
      return;
    }

    this.lastSkipReason = null;
    const idTag = this.hooks.idTag?.(this.connectorId) ?? AUTO_TRAFFIC_ID_TAG;
    try {
      if (this.config.requireAuthorize) {
        let accepted: boolean;
        try {
          accepted = await this.hooks.authorize(this.connectorId, idTag);
        } catch (err) {
          this.counters.authorizeRejected++;
          throw err;
        }
        if (this.stopped) return;
        if (!accepted) {
          this.counters.authorizeRejected++;
          this.counters.rejected++;
          this.scheduleNext();
          return;
        }
        this.counters.authorizeAccepted++;
      }
      const started = await this.hooks
        .startTransaction(this.connectorId, idTag)
        .catch((err: unknown) => {
          this.counters.startRejected++;
          throw err;
        });
      if (started === false) {
        this.counters.startRejected++;
        this.counters.rejected++;
        this.hooks.log(
          `[auto-traffic] ${this.cpId}/${this.connectorId} start refused`,
        );
        this.scheduleNext();
        return;
      }
      // Re-checked after every await: `stop()` can land while the authorize or
      // the start is in flight, and without this the runner would install a
      // fresh timer after cancellation.
      if (this.stopped) {
        await this.hooks
          .stopTransaction(this.connectorId)
          .catch(() => undefined);
        return;
      }
      this.sessionOpen = true;
      this.startConfSettled = false;
      this.counters.started++;
      this.counters.startAccepted++;
      this.counters.consecutiveSkips = 0;
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

    this.timer = this.clock.setTimeout(
      () => {
        this.timer = null;
        void this.endSession();
      },
      Math.max(0, durationSec * 1000),
    );
  }

  private async endSession(): Promise<void> {
    if (this.stopped) return;
    if (this.hooks.poweredOff?.(this.connectorId)) {
      this.timer = this.clock.setTimeout(() => {
        this.timer = null;
        void this.endSession();
      }, POWER_RECHECK_MS);
      return;
    }
    try {
      this.sessionOpen = false;
      await this.hooks.stopTransaction(this.connectorId);
      this.counters.completed++;
      this.counters.stopAccepted++;
    } catch (err) {
      this.counters.stopRejected++;
      this.hooks.log(
        `[auto-traffic] ${this.cpId}/${this.connectorId} stop failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.scheduleNext();
  }
}
