import type {
  Behavior,
  BehaviorContext,
  CallBehavior,
  CallOutcome,
} from "@ocpp-cp-simulator/contracts/behavior";
import type { ChargePoint } from "../../domain/charge-point/ChargePoint";
import type { DefaultResult } from "../../domain/engine/ChargePointEngine";
import type { BehaviorCall, HeldExchange } from "../behavior/BehaviorRegistry";
import { responseProblems } from "./responseValidation";
import {
  BehaviorStopped,
  CONNECTION_BOUND_DEFAULTS,
  Scope,
  describe,
  isThenable,
  type CallEnv,
} from "./scope";

/** What the call runner needs of its engine: the engine's tables (shared by reference) and a few of its private steps. */
export interface CallRunnerEngine {
  readonly host: ChargePoint;
  readonly callScopes: Set<Scope>;
  readonly defaults: Map<string, { behavior: Behavior; call: CallBehavior }>;
  touch(): void;
  warn(message: string): void;
  endScope(scope: Scope): void;
  makeContext(behaviorId: string, scope: Scope, env?: CallEnv): BehaviorContext;
}

/**
 * Runs the handler of a CALL: a code behavior's rule (`runCall`) or a default
 * behavior (`runDefault`), turns its outcome into the answer, and runs the
 * follow-up (docs/concepts/charger-engine.md). The tables stay on the engine.
 */
export class CallRunner {
  constructor(private readonly e: CallRunnerEngine) {}

  /** A rule of a code behavior took the CALL. */
  runCall(
    behavior: Behavior,
    call: CallBehavior,
    info: BehaviorCall,
    exchange: HeldExchange,
  ): void {
    const scope = new Scope(behavior.id, true);
    this.e.callScopes.add(scope);
    const env: CallEnv = {
      action: info.action,
      mode: call.mode,
      defaultEffects: [],
    };
    const ctx = this.e.makeContext(behavior.id, scope, env);
    const fail = (error: unknown): void => {
      this.e.touch();
      this.e.endScope(scope);
      const stopped = error instanceof BehaviorStopped;
      if (!stopped) {
        this.e.warn(
          `Behavior ${behavior.id} failed on ${info.action}: ${describe(error)}`,
        );
      }
      // A handler cut off while its CALL is still open (the behavior was
      // unloaded after a reload had let go of the rule that held the CALL)
      // answers InternalError, as an unload with the rule in place does.
      if (exchange.state === "open") {
        exchange.replyError(
          "InternalError",
          stopped
            ? `Behavior ${behavior.id} was stopped`
            : describe(error).slice(0, 255),
        );
      }
    };
    const finish = (outcome: CallOutcome): void => {
      this.e.touch();
      try {
        this.answer(behavior.id, scope, ctx, env, info, exchange, outcome);
      } catch (error) {
        fail(error);
      }
    };
    let handled: CallOutcome | Promise<CallOutcome>;
    try {
      handled = call.handle(info.payload, ctx);
    } catch (error) {
      fail(error);
      return;
    }
    // Only a real promise defers the answer: a synchronous handler answers in
    // the turn the CALL arrived (#456).
    if (isThenable(handled)) {
      Promise.resolve(handled).then(finish, fail);
    } else {
      finish(handled);
    }
  }

  private answer(
    behaviorId: string,
    scope: Scope,
    ctx: BehaviorContext,
    env: CallEnv,
    info: BehaviorCall,
    exchange: HeldExchange,
    outcome: CallOutcome,
  ): void {
    if (exchange.state !== "open" && exchange.state !== "abandoned") {
      this.e.endScope(scope);
      return;
    }
    const afterUser = outcome.after;
    const effect = (settled?: string): void => {
      // The follow-up the default behaviors of ctx.defaultBehavior started
      // keeps the rules of the response queue (as before the engine). The
      // follow-up of the behavior itself needs its answer on the wire.
      for (const defaultEffect of env.defaultEffects) defaultEffect();
      if (afterUser && (settled === undefined || settled === "written")) {
        this.runAfter(behaviorId, scope, ctx, afterUser);
      } else {
        if (afterUser) {
          this.e.warn(
            `Behavior ${behaviorId}: the answer to ${info.action} was not delivered (${settled}); its follow-up is skipped`,
          );
        }
        this.e.endScope(scope);
      }
    };
    const dropped = (reason: string): void => {
      this.e.warn(
        `Behavior ${behaviorId}: the answer to ${info.action} was not delivered (${reason}); its follow-up is skipped`,
      );
      this.e.endScope(scope);
    };
    if ("noResponse" in outcome) {
      if (exchange.state !== "open") {
        // The CALL was abandoned (the connection closed) while the handler
        // ran: nothing was suppressed, so nothing follows.
        dropped("the connection closed");
        return;
      }
      void exchange.suppress();
      effect();
      return;
    }
    if ("error" in outcome) {
      exchange.replyError(outcome.error.code, outcome.error.description, {
        effect,
        onEffectDropped: dropped,
      });
      return;
    }
    if (!outcome.skipValidation) {
      const problems = responseProblems(
        info.action,
        this.e.host.ocppVersion,
        outcome.response,
      );
      if (problems.length > 0) {
        this.e.warn(
          `Behavior ${behaviorId} produced an invalid ${info.action} response: ${problems.join("; ")}`,
        );
        this.e.endScope(scope);
        exchange.replyError(
          "InternalError",
          `Invalid ${info.action} response from behavior ${behaviorId}`.slice(
            0,
            255,
          ),
        );
        return;
      }
    }
    exchange.reply(outcome.response, { effect, onEffectDropped: dropped });
  }

  private runAfter(
    behaviorId: string,
    scope: Scope,
    ctx: BehaviorContext,
    after: () => Promise<void>,
  ): void {
    // Started in the turn the response settled (as the effects it replaces
    // were), up to its first wait.
    let running: Promise<void>;
    try {
      running = Promise.resolve(after());
    } catch (error) {
      running = Promise.reject(error);
    }
    void running
      .catch((error: unknown) => {
        if (error instanceof BehaviorStopped) return;
        this.e.warn(
          `Behavior ${behaviorId}: follow-up failed: ${describe(error)}`,
        );
      })
      .finally(() => {
        this.e.touch();
        this.e.endScope(scope);
      });
    void ctx;
  }

  /**
   * Run the default behavior of `action` for a request that reached the
   * default path. Written for the handlers: the response, and the effect that
   * starts the follow-up once the response settled.
   */
  runDefault(action: string, payload: unknown): DefaultResult {
    const entry = this.e.defaults.get(action);
    if (!entry) throw new Error(`No default behavior answers ${action}`);
    // Not connection-bound while the answer is in the pipeline: a close before
    // the follow-up starts cancels nothing (the follow-up then runs, as the
    // old code ran it). See `CONNECTION_BOUND_DEFAULTS` for what binds it once
    // it runs.
    const scope = new Scope(entry.behavior.id, false);
    this.e.callScopes.add(scope);
    const env: CallEnv = { action, mode: "default", defaultEffects: [] };
    const ctx = this.e.makeContext(entry.behavior.id, scope, env);
    let outcome: CallOutcome | Promise<CallOutcome>;
    try {
      outcome = entry.call.handle(payload, ctx);
    } catch (error) {
      this.e.endScope(scope);
      throw error;
    }
    if (isThenable(outcome)) {
      this.e.endScope(scope);
      throw new Error(
        `Default behavior of ${action} must answer synchronously`,
      );
    }
    if (!("response" in outcome)) {
      this.e.endScope(scope);
      throw new Error(
        `Default behavior of ${action} did not produce a response`,
      );
    }
    const after = outcome.after;
    if (!after) {
      this.e.endScope(scope);
      return { response: outcome.response };
    }
    const effect = (): void => {
      scope.connectionBound = CONNECTION_BOUND_DEFAULTS.has(entry.behavior.id);
      this.runAfter(entry.behavior.id, scope, ctx, after);
    };
    // The response queue drops an effect on a close the station made, a stale
    // generation or a dispose: nothing would end this scope then.
    effect.onDropped = (): void => this.e.endScope(scope);
    return { response: outcome.response, effect };
  }
}
