import type { Settlement } from "./NetworkSimPipeline";
import type { GenerationToken } from "./NetworkSimController";

export interface HandlerOutcome {
  kind: "handler-outcome";
  payload: unknown;
  afterResponseSettled: () => void;
}

export type HandlerResult = unknown | HandlerOutcome;

/**
 * Type guard to check if a value is a HandlerOutcome.
 */
export function isHandlerOutcome(r: HandlerResult): r is HandlerOutcome {
  return (
    r != null &&
    typeof r === "object" &&
    (r as { kind?: unknown }).kind === "handler-outcome"
  );
}

/**
 * Normalize a handler result into payload and optional effect.
 * If the result is a HandlerOutcome, extract the payload and effect.
 * Otherwise, treat the entire result as a payload with no effect.
 */
export function normalizeHandlerResult(r: HandlerResult): {
  payload: unknown;
  effect: (() => void) | null;
} {
  if (isHandlerOutcome(r)) {
    return {
      payload: r.payload,
      effect: r.afterResponseSettled,
    };
  }
  return {
    payload: r,
    effect: null,
  };
}

export interface ResponseEffectQueueDeps {
  /**
   * Check if a generation token is the current live generation.
   * Returns true iff the generation is not stale (not superseded by a newer connect).
   */
  isGenerationCurrent(gen: GenerationToken): boolean;

  /**
   * Schedule a callback to run after the current synchronous release/drain.
   * In production, this should use queueMicrotask.
   */
  defer(run: () => void): void;

  /**
   * Log a message.
   */
  log(message: string): void;
}

/**
 * ResponseEffectQueue manages post-response side effects with complex scheduling semantics.
 *
 * Effects are registered per generation. They can settle in various ways:
 * - "written" | "write_failed" | "queue_overflow": effect is deferred and run if generation is current
 * - "socket_closed": effect is held until flushAfterCloseFinalization is called
 * - "disposed": effect is dropped immediately
 *
 * Late-registered effects (socket_closed after finalization) are resolved immediately
 * based on the finalized generation's latched closeCause.
 */
export class ResponseEffectQueue {
  private readonly deps: ResponseEffectQueueDeps;
  private heldEffects = new Map<number, Array<() => void>>();
  private finalizedGenerations = new Set<number>();
  private highestFinalizedGen = -1;

  constructor(deps: ResponseEffectQueueDeps) {
    this.deps = deps;
  }

  /**
   * Register an effect for a generation. Returns a settlement hook that should be
   * passed as the onSettled callback to the response-send pipeline.
   */
  public register(
    gen: GenerationToken,
    effect: () => void,
  ): (s: Settlement) => void {
    return (settlement: Settlement) => {
      const outcome = settlement.outcome;

      if (
        outcome === "written" ||
        outcome === "write_failed" ||
        outcome === "queue_overflow"
      ) {
        // Schedule the effect via defer, guarded by stale check at run-time
        this.deps.defer(() => {
          if (!this.deps.isGenerationCurrent(gen)) {
            this.deps.log(
              `Response effect queue: skipped stale effect for generation ${gen.gen}`,
            );
            return;
          }
          this.runEffect(effect);
        });
      } else if (outcome === "socket_closed") {
        // Check if this generation has already been finalized
        if (this.isGenerationFinalized(gen.gen)) {
          // Late registration: resolve immediately using latched closeCause
          this.resolveLateSocketClosedEffect(gen, effect);
        } else {
          // Hold the effect until flushAfterCloseFinalization is called
          if (!this.heldEffects.has(gen.gen)) {
            this.heldEffects.set(gen.gen, []);
          }
          this.heldEffects.get(gen.gen)!.push(effect);
        }
      } else if (outcome === "disposed") {
        this.deps.log(
          `Response effect queue: dropped effect for disposed generation ${gen.gen}`,
        );
      }
    };
  }

  /**
   * Flush all held effects for a generation after its close transaction finalizes.
   * Decides whether to run or drop effects based on the generation's latched closeCause.
   */
  public flushAfterCloseFinalization(finalized: GenerationToken): void {
    const gen = finalized.gen;
    const effects = this.heldEffects.get(gen);

    if (effects) {
      this.heldEffects.delete(gen);

      // Decide based on closeCause
      const closeCause = finalized.closeCause ?? "network";
      if (closeCause === "network" || closeCause === "simulated") {
        // Schedule effects via defer with stale check
        for (const effect of effects) {
          this.deps.defer(() => {
            if (!this.deps.isGenerationCurrent(finalized)) {
              this.deps.log(
                `Response effect queue: skipped stale effect during finalization flush for generation ${gen}`,
              );
              return;
            }
            this.runEffect(effect);
          });
        }
      } else if (closeCause === "manual" || closeCause === "internal") {
        // Drop effects for manual/internal disconnects
        for (const _ of effects) {
          this.deps.log(
            `Response effect queue: dropped effect for ${closeCause} disconnect (generation ${gen})`,
          );
        }
      }
    }

    // Mark this generation as finalized
    this.markGenerationFinalized(gen);
  }

  /**
   * Check if a generation has been finalized.
   * Uses an optimized check that tracks the highest finalized generation.
   */
  private isGenerationFinalized(gen: number): boolean {
    if (gen <= this.highestFinalizedGen) {
      return true;
    }
    return this.finalizedGenerations.has(gen);
  }

  /**
   * Mark a generation as finalized, with cleanup to avoid unbounded growth.
   */
  private markGenerationFinalized(gen: number): void {
    if (gen > this.highestFinalizedGen) {
      this.highestFinalizedGen = gen;
      // Clean up old finalized generations
      if (this.finalizedGenerations.size > 100) {
        // Only keep generations higher than (highestFinalizedGen - 50)
        const threshold = this.highestFinalizedGen - 50;
        for (const finalized of this.finalizedGenerations) {
          if (finalized <= threshold) {
            this.finalizedGenerations.delete(finalized);
          }
        }
      }
    } else if (gen !== this.highestFinalizedGen) {
      this.finalizedGenerations.add(gen);
    }
  }

  /**
   * Resolve a late socket_closed effect (registered after finalization).
   * Uses the generation's latched closeCause to decide whether to run or drop.
   */
  private resolveLateSocketClosedEffect(
    gen: GenerationToken,
    effect: () => void,
  ): void {
    const closeCause = gen.closeCause ?? "network";

    if (closeCause === "network" || closeCause === "simulated") {
      // Schedule effect via defer with stale check
      this.deps.defer(() => {
        if (!this.deps.isGenerationCurrent(gen)) {
          this.deps.log(
            `Response effect queue: skipped stale late-registered effect for generation ${gen.gen}`,
          );
          return;
        }
        this.runEffect(effect);
      });
    } else if (closeCause === "manual" || closeCause === "internal") {
      // Drop effect
      this.deps.log(
        `Response effect queue: dropped late-registered effect for ${closeCause} disconnect (generation ${gen.gen})`,
      );
    }
  }

  /**
   * Run an effect with exception guard so a throwing effect doesn't break the queue.
   */
  private runEffect(effect: () => void): void {
    try {
      effect();
    } catch (error) {
      this.deps.log(`Response effect queue: effect threw: ${error}`);
    }
  }
}
