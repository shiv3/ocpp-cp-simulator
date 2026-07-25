import { evaluateDelayMsWithLogging } from "./LatencyPolicy";
import {
  NetworkSimPipeline,
  type CloseCause,
  type Settlement,
} from "./NetworkSimPipeline";
import { parseFrameContext } from "./FrameContext";
import { draw, makeRuleRng } from "./SeededRng";
import { sanitizeForLog } from "./logSanitize";
import {
  MAX_TIMER_MS,
  type PeriodicDisconnectRule,
  type ResolvedNetworkSimConfig,
} from "./config";

export interface ControllerHost {
  writeUpstream(raw: string): void;
  dispatchDownstream(raw: string): void;
  requestSimulatedDisconnect(reconnectDelayMs: number, ruleId: string): void;
  log(message: string): void;
}

export interface GenerationToken {
  readonly gen: number;
  readonly closeCause: CloseCause | null;
}

type PipelineShutdown = {
  reason: "socket_closed" | "disposed";
  closeCause?: CloseCause;
};

type PeriodicTimer = {
  handle: ReturnType<typeof setTimeout>;
  dueAt: number;
  rule: PeriodicDisconnectRule;
};

export class NetworkSimController {
  private resolved: ResolvedNetworkSimConfig | undefined;
  private ruleRngs = new Map<string, () => number>();
  private readonly periodicTimers = new Map<string, PeriodicTimer>();
  private upstreamPipeline: NetworkSimPipeline;
  private downstreamPipeline: NetworkSimPipeline;
  private pipelinesStopped = false;
  private isOpen = false;
  private disposed = false;
  private configRevision = 0;
  private disconnectRequestedThisSession = false;

  public constructor(
    private readonly host: ControllerHost,
    private readonly chargePointId: string,
  ) {
    [this.upstreamPipeline, this.downstreamPipeline] = this.createPipelines();
  }

  public applyConfig(resolved: ResolvedNetworkSimConfig): void {
    this.cancelPeriodicTimers();
    this.resolved = resolved;
    this.configRevision += 1;

    const ruleRngs = new Map<string, () => number>();
    for (const ruleId of Object.keys(resolved.rules)) {
      ruleRngs.set(ruleId, makeRuleRng(resolved.seed, ruleId));
    }
    this.ruleRngs = ruleRngs;

    // Queued frames remain in their current pipelines with their enqueue-time
    // deadlines; only future evaluations and periodic schedules are replaced.
    if (this.isOpen && resolved.enabled && !this.disposed) {
      this.armPeriodicTimers();
    }
  }

  public sendUpstream(
    raw: string,
    onSettled?: (settlement: Settlement) => void,
  ): boolean {
    if (this.resolved?.enabled !== true) {
      // When disabled, only take the synchronous fast path if the pipeline is empty.
      // If frames are still draining from a prior enabled state, enqueue with 0 delay
      // to preserve FIFO ordering.
      if (this.upstreamPipeline.size === 0) {
        this.host.writeUpstream(raw);
        onSettled?.({ outcome: "written" });
        return true;
      }
      return this.upstreamPipeline.enqueue(raw, 0, onSettled);
    }

    const frameContext = parseFrameContext(raw, "upstream");
    const { delayMs, matchedRules } = evaluateDelayMsWithLogging(
      frameContext,
      this.resolved.rules,
      (ruleId) => this.rngFor(ruleId),
    );

    // Log each matched latency rule
    for (const { ruleId, delayMs: ruleDelay } of matchedRules) {
      if (ruleDelay > 0) {
        const sanitizedRuleId = sanitizeForLog(ruleId);
        const sanitizedAction = sanitizeForLog(frameContext.action ?? "");
        const sanitizedMessageId = sanitizeForLog(frameContext.messageId ?? "");
        this.host.log(
          `[RULE:${sanitizedRuleId}] LATENCY +${ruleDelay}ms → ${sanitizedAction} (${sanitizedMessageId})`,
        );
      }
    }

    return this.upstreamPipeline.enqueue(raw, delayMs, onSettled);
  }

  public receiveDownstream(raw: string): void {
    if (this.resolved?.enabled !== true) {
      // When disabled, only take the synchronous fast path if the pipeline is empty.
      // If frames are still draining from a prior enabled state, enqueue with 0 delay
      // to preserve FIFO ordering.
      if (this.downstreamPipeline.size === 0) {
        this.host.dispatchDownstream(raw);
        return;
      }
      if (!this.downstreamPipeline.enqueue(raw, 0)) {
        this.host.log(
          `Network simulation discarded downstream frame for ${this.chargePointId}: queue_overflow`,
        );
      }
      return;
    }

    const frameContext = parseFrameContext(raw, "downstream");
    const { delayMs, matchedRules } = evaluateDelayMsWithLogging(
      frameContext,
      this.resolved.rules,
      (ruleId) => this.rngFor(ruleId),
    );

    // Log each matched latency rule
    for (const { ruleId, delayMs: ruleDelay } of matchedRules) {
      if (ruleDelay > 0) {
        const sanitizedRuleId = sanitizeForLog(ruleId);
        const sanitizedAction = sanitizeForLog(frameContext.action ?? "");
        const sanitizedMessageId = sanitizeForLog(frameContext.messageId ?? "");
        this.host.log(
          `[RULE:${sanitizedRuleId}] LATENCY +${ruleDelay}ms → ${sanitizedAction} (${sanitizedMessageId})`,
        );
      }
    }

    if (!this.downstreamPipeline.enqueue(raw, delayMs)) {
      this.host.log(
        `Network simulation discarded downstream frame for ${this.chargePointId}: queue_overflow`,
      );
    }
  }

  public onSocketOpen(): void {
    if (this.disposed) {
      return;
    }

    this.isOpen = true;
    this.disconnectRequestedThisSession = false;
    if (this.pipelinesStopped) {
      [this.upstreamPipeline, this.downstreamPipeline] = this.createPipelines();
      this.pipelinesStopped = false;
    }

    this.cancelPeriodicTimers();
    if (this.resolved?.enabled === true) {
      this.armPeriodicTimers();
    }
  }

  public shutdownPipelines(settlement: PipelineShutdown): void {
    this.isOpen = false;
    this.cancelPeriodicTimers();
    this.upstreamPipeline.shutdown(settlement);
    this.downstreamPipeline.shutdown(settlement);
    this.pipelinesStopped = true;
  }

  public triggerManualDisconnect(
    ruleId: string,
  ): { ok: true } | { ok: false; error: "sim_disabled" | "rule_not_manual" } {
    if (this.resolved?.enabled !== true) {
      return { ok: false, error: "sim_disabled" };
    }

    const rule = this.resolved.rules[ruleId];
    if (rule?.type !== "manual-disconnect") {
      return { ok: false, error: "rule_not_manual" };
    }

    if (!this.disconnectRequestedThisSession) {
      this.disconnectRequestedThisSession = true;
      const sanitizedRuleId = sanitizeForLog(ruleId);
      this.host.log(
        `[RULE:${sanitizedRuleId}] DISCONNECT forced; reconnect blocked ${rule.reconnectDelayMs}ms`,
      );
      this.host.requestSimulatedDisconnect(rule.reconnectDelayMs, ruleId);
    }
    return { ok: true };
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.shutdownPipelines({ reason: "disposed" });
    this.disposed = true;
  }

  private createPipelines(): [NetworkSimPipeline, NetworkSimPipeline] {
    return [
      new NetworkSimPipeline((raw) => this.host.writeUpstream(raw)),
      new NetworkSimPipeline((raw) => this.host.dispatchDownstream(raw), {
        onDiscard: (_raw, settlement) => {
          this.host.log(
            `Network simulation discarded downstream frame for ${this.chargePointId}: ${settlement.outcome}`,
          );
        },
      }),
    ];
  }

  private rngFor(ruleId: string): () => number {
    const rng = this.ruleRngs.get(ruleId);
    if (rng === undefined) {
      throw new Error(`Missing network simulation RNG for rule "${ruleId}"`);
    }
    return rng;
  }

  private armPeriodicTimers(): void {
    const resolved = this.resolved;
    if (
      resolved === undefined ||
      !resolved.enabled ||
      !this.isOpen ||
      this.disposed
    ) {
      return;
    }

    for (const ruleId of Object.keys(resolved.rules)) {
      const rule = resolved.rules[ruleId];
      if (rule.type === "periodic-disconnect") {
        this.armPeriodicTimer(
          ruleId,
          rule,
          this.configRevision,
          this.rngFor(ruleId),
        );
      }
    }
  }

  private armPeriodicTimer(
    ruleId: string,
    rule: PeriodicDisconnectRule,
    revision: number,
    rng: () => number,
  ): void {
    if (!this.isOpen || this.disposed || revision !== this.configRevision) {
      return;
    }

    const jitter =
      rule.intervalJitterMs === undefined
        ? 0
        : draw(rng, rule.intervalJitterMs);
    const scheduledInterval = Math.min(MAX_TIMER_MS, rule.intervalMs + jitter);

    // Each rule owns exactly one timer. Removing the firing handle before the
    // host callback prevents the same interval from being observed twice.
    const handle = setTimeout(
      () => this.firePeriodicTimers(ruleId, handle),
      scheduledInterval,
    );
    const timer: PeriodicTimer = {
      handle,
      dueAt: Date.now() + scheduledInterval,
      rule,
    };
    this.periodicTimers.set(ruleId, timer);
  }

  private firePeriodicTimers(
    firingRuleId: string,
    firingHandle: ReturnType<typeof setTimeout>,
  ): void {
    if (this.periodicTimers.get(firingRuleId)?.handle !== firingHandle) {
      return;
    }

    const now = Date.now();
    const dueTimers = Array.from(this.periodicTimers.entries()).filter(
      ([, timer]) => timer.dueAt <= now,
    );

    // Iterate a snapshot because the host may synchronously close the socket
    // and clear the live timer map. Only the first armed timer in a socket
    // session requests a disconnect; schedules restart on the next open.
    for (const [ruleId, timer] of dueTimers) {
      if (this.periodicTimers.get(ruleId)?.handle !== timer.handle) {
        continue;
      }

      clearTimeout(timer.handle);
      this.periodicTimers.delete(ruleId);
      if (this.disconnectRequestedThisSession) {
        continue;
      }

      this.disconnectRequestedThisSession = true;
      const sanitizedRuleId = sanitizeForLog(ruleId);
      this.host.log(
        `[RULE:${sanitizedRuleId}] DISCONNECT forced; reconnect blocked ${timer.rule.reconnectDelayMs}ms`,
      );
      this.host.requestSimulatedDisconnect(timer.rule.reconnectDelayMs, ruleId);
    }
  }

  private cancelPeriodicTimers(): void {
    for (const timer of this.periodicTimers.values()) {
      clearTimeout(timer.handle);
    }
    this.periodicTimers.clear();
  }
}
