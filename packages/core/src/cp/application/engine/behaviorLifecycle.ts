import type {
  Behavior,
  BehaviorContext,
  CallBehavior,
  JsonObject,
  JsonValue,
} from "@ocpp-cp-simulator/contracts/behavior";
import type { ChargePoint } from "../../domain/charge-point/ChargePoint";
import type { LoadBehaviorOptions } from "../../domain/engine/ChargePointEngine";
import type { EngineEvent } from "./ChargerState";
import { ruleKey, ruleOwnerKey } from "../behavior/BehaviorRegistry";
import type { BehaviorRule, RuleOwner } from "../behavior/BehaviorRegistry";
import { mergeParams } from "../behavior/paramsSchema";
import { behaviorFitProblem, behaviorShapeProblem } from "./behaviorFit";
import { cannedResponse } from "./responseValidation";
import { Scope } from "./scope";

/** What the lifecycle needs of its engine: the engine's tables (shared by reference) and a few of its private steps. */
export interface BehaviorLifecycleEngine {
  readonly host: ChargePoint;
  readonly loaded: Map<string, Behavior>;
  readonly dormant: Set<string>;
  readonly holders: Map<string, Map<string, RuleOwner>>;
  readonly mainScopes: Map<string, Scope>;
  readonly resumeScopes: Map<string, Scope>;
  readonly mainRuns: Map<string, Promise<void>>;
  readonly pendingMains: Map<string, () => void>;
  readonly callScopes: Set<Scope>;
  readonly defaultsById: Map<string, Behavior>;
  readonly selectionParams: Map<string, JsonObject>;
  readonly paramLayers: Map<
    string,
    Map<string, { owner: RuleOwner; params: JsonObject }>
  >;
  readonly hookContexts: Map<string, { scope: Scope; ctx: BehaviorContext }>;
  /** The orphaned state, a field the engine reassigns. */
  orphans(): Record<string, Record<string, JsonValue>>;
  disposed(): boolean;
  dispatch(event: EngineEvent): void;
  warn(message: string): void;
  hasDefaultFor(action: string): boolean;
  isIdle(id: string): boolean;
  refreshHooked(): void;
  adoptState(id: string, data: Record<string, JsonValue>): boolean;
  endScope(scope: Scope): void;
  endHookContext(id: string): void;
  runDetached(
    behaviorId: string,
    scope: Scope,
    run: (ctx: BehaviorContext) => Promise<void>,
  ): Promise<void>;
  runCall(
    behavior: Behavior,
    call: CallBehavior,
    callInfo: Parameters<BehaviorRule["take"]>[0],
    exchange: Parameters<BehaviorRule["take"]>[1],
  ): void;
}

/**
 * Load, reload, select, parameterize and unload of code behaviors, and
 * `onResume` (docs/concepts/charger-engine.md). The engine delegates its
 * public methods here; the tables stay on the engine.
 */
export class BehaviorLifecycle {
  constructor(private readonly e: BehaviorLifecycleEngine) {}

  // ---- code behaviors -----------------------------------------------------

  /** Throws if this station cannot run `behavior`. */
  assertLoadable(behavior: Behavior): void {
    const shape = behaviorShapeProblem(behavior, (action) =>
      this.e.hasDefaultFor(action),
    );
    if (shape) throw new Error(shape);
    const problem = behaviorFitProblem(behavior, {
      ocppVersion: this.e.host.ocppVersion,
    });
    if (problem) throw new Error(problem);
  }

  /**
   * Load a behavior: check its `requires`, register the rule of every
   * `onCall` entry, and start `main`. Throws on a duplicate id or a capability
   * this station cannot meet; nothing is registered then.
   */
  loadBehavior(behavior: Behavior, options: LoadBehaviorOptions = {}): void {
    this.assertLoadable(behavior);
    if (this.e.loaded.has(behavior.id)) {
      throw new Error(`Behavior ${behavior.id} is already loaded`);
    }
    if (options.params !== undefined) {
      // Refuse before anything is registered or started.
      mergeParams(behavior.id, behavior.params, [options.params]);
    }
    if (!options.dormant) {
      this.registerRules(behavior, { kind: "code", behaviorId: behavior.id });
    }
    // Only now that nothing can throw any more: a failed load leaves no entry.
    if (options.params !== undefined) {
      this.e.selectionParams.set(behavior.id, options.params);
    }
    this.e.loaded.set(behavior.id, behavior);
    if (options.dormant) this.e.dormant.add(behavior.id);
    this.e.refreshHooked();
    this.e.dispatch({ type: "behavior.loaded", behaviorId: behavior.id });
    const orphan = this.e.orphans()[behavior.id];
    if (orphan) {
      delete this.e.orphans()[behavior.id];
      this.e.adoptState(behavior.id, orphan);
    }
    if (behavior.main && !options.dormant) {
      const scope = new Scope(behavior.id, false);
      this.e.mainScopes.set(behavior.id, scope);
      this.e.mainRuns.set(
        behavior.id,
        this.e.runDetached(behavior.id, scope, (ctx) => behavior.main!(ctx)),
      );
    }
  }

  /** How long a running `main` gets to finish once a reload asked it to stop. */
  static readonly RELOAD_GRACE_MS = 5_000;

  /**
   * Replace a loaded behavior with a new version of the same id (a reload).
   * It is atomic: a version the station cannot take (`requires`, `beforeSend`
   * on SOAP, a rule that cannot be registered) throws, and the old one keeps
   * running untouched.
   *
   * Exchanges in flight finish on the old code; a CALL that arrives after this
   * returns, a hook event and a `beforeSend` use the new one. `ctx.state`
   * survives. A running `main` sees `ctx.stopping` and gets
   * {@link ChargerEngine.RELOAD_GRACE_MS} on the station's clock to return,
   * after which its waits are cut off; the new `main` starts when the old one
   * has returned or the grace time is over, whichever is first.
   */
  replaceBehavior(next: Behavior): void {
    const previous = this.e.loaded.get(next.id);
    if (!previous) {
      throw new Error(
        `No behavior with id "${next.id}" is loaded on this station`,
      );
    }
    this.assertLoadable(next);
    // The params in force must fit the new version's schema, or it is refused
    // and the old version keeps running.
    mergeParams(next.id, next.params, this.layersOf(next.id));
    const dormant = this.e.dormant.has(next.id);
    if (!dormant) {
      // Register the new rules in place of the old ones; the exchanges the old
      // rules hold open are left to finish (their closures keep the old code).
      const owned = (owner: RuleOwner): boolean =>
        owner.kind === "code" && owner.behaviorId === next.id;
      // The new rules take the place of the old ones in the ranking: a reload
      // must not make this behavior win or lose against another one.
      const ranks = this.e.host.behaviors.ranks(owned);
      this.e.host.behaviors.release(owned);
      try {
        this.registerRules(next, { kind: "code", behaviorId: next.id }, ranks);
      } catch (error) {
        this.e.host.behaviors.release(owned);
        this.registerRules(
          previous,
          { kind: "code", behaviorId: next.id },
          ranks,
        );
        throw error;
      }
    }
    this.e.loaded.set(next.id, next);
    this.e.refreshHooked();
    // The hooks of the old version wind down like its main.
    const oldHooks = this.e.hookContexts.get(next.id);
    this.e.hookContexts.delete(next.id);
    const oldMain = this.e.mainScopes.get(next.id);
    this.e.mainScopes.delete(next.id);
    const oldRun = this.e.mainRuns.get(next.id);
    this.e.mainRuns.delete(next.id);
    const oldResume = this.e.resumeScopes.get(next.id);
    this.e.resumeScopes.delete(next.id);
    this.e.pendingMains.get(next.id)?.();
    this.e.pendingMains.delete(next.id);

    let startedNew = false;
    const startNew = (): void => {
      if (startedNew) return;
      startedNew = true;
      if (this.e.isIdle(next.id) || !next.main || this.e.disposed()) return;
      if (this.e.loaded.get(next.id) !== next) return;
      const scope = new Scope(next.id, false);
      this.e.mainScopes.set(next.id, scope);
      this.e.mainRuns.set(
        next.id,
        this.e.runDetached(next.id, scope, (ctx) => next.main!(ctx)),
      );
    };
    const winding = [oldMain, oldResume, oldHooks?.scope].filter(
      (scope): scope is Scope => scope !== undefined,
    );
    for (const scope of winding) scope.requestStop();
    if (winding.length === 0) {
      startNew();
    } else {
      const clock = this.e.host.clock;
      const endGrace = (): void => {
        clock.clearTimeout(timer);
        this.e.pendingMains.delete(next.id);
        for (const scope of winding) scope.cancel();
        startNew();
      };
      const timer = clock.setTimeout(
        endGrace,
        BehaviorLifecycle.RELOAD_GRACE_MS,
      );
      // Unload, dispose or another reload before the grace time is over: cut
      // the old work off now, and the new main (if not started) never starts.
      this.e.pendingMains.set(next.id, () => {
        clock.clearTimeout(timer);
        for (const scope of winding) scope.cancel();
        startedNew = true;
      });
      if (oldRun) void oldRun.then(startNew);
      else startNew();
    }
    this.e.dispatch({ type: "behavior.loaded", behaviorId: next.id });
  }

  /**
   * Put the rules of a behavior loaded `dormant` to work under `owner` (a
   * scenario run, schema 1.5 `useBehavior`). The rules end with the owner:
   * release them with `BehaviorRegistry.release`. A behavior that is not
   * dormant already serves its rules; selecting it again does nothing. Throws
   * if no behavior has that id.
   *
   * `params` (schema 1.6) are the run's layer over the station's selection and
   * the behavior's defaults; they are validated first, so a refusal arms
   * nothing, and they end with the owner like the rules. A built-in
   * `default.*` behavior always answers: selecting one only sets its params.
   */
  activateBehavior(id: string, owner: RuleOwner, params?: JsonObject): void {
    const builtin = this.e.defaultsById.get(id);
    const behavior = builtin ?? this.e.loaded.get(id);
    if (!behavior) {
      throw new Error(`No behavior with id "${id}" is loaded on this station`);
    }
    const key = ruleOwnerKey(owner);
    // Selecting a behavior again under the same owner (a `useBehavior` node
    // in a loop) replaces its params and rules instead of stacking them.
    this.setParamLayer(id, behavior, owner, params);
    if (builtin || !this.e.dormant.has(id)) return;
    this.e.host.behaviors.release((held) => ruleOwnerKey(held) === key);
    this.registerRules(behavior, owner);
    const held = this.e.holders.get(id) ?? new Map<string, RuleOwner>();
    const first = held.size === 0;
    held.set(key, owner);
    this.e.holders.set(id, held);
    if (!first) return;
    // The first owner switches the whole behavior on: `main` starts, hooks
    // and `beforeSend` are delivered.
    this.e.refreshHooked();
    if (behavior.main && !this.e.mainScopes.has(id) && !this.e.disposed()) {
      const scope = new Scope(id, false);
      this.e.mainScopes.set(id, scope);
      this.e.mainRuns.set(
        id,
        this.e.runDetached(id, scope, (ctx) => behavior.main!(ctx)),
      );
    }
  }

  /**
   * Schema 1.6 `useBehavior` with `mode: "disable"`: for as long as `owner`
   * lives, every CALL of the behavior's actions is answered with the version's
   * `accepted` answer (`ctx.accepted(action)`) and nothing follows. The rules
   * are scenario rules, so they outrank the behavior's own (call-precedence
   * step 3) and end with the run. Throws when no behavior has that id, when
   * the station has no `accepted` answer for any of its actions, or when the
   * station cannot take scenario rules.
   */
  disableBehavior(id: string, owner: RuleOwner): void {
    const behavior = this.e.defaultsById.get(id) ?? this.e.loaded.get(id);
    if (!behavior) {
      throw new Error(`No behavior with id "${id}" is loaded on this station`);
    }
    const answers: Array<[string, Record<string, unknown>]> = [];
    for (const action of Object.keys(behavior.onCall ?? {})) {
      try {
        answers.push([
          action,
          cannedResponse(action, this.e.host.ocppVersion, "accepted"),
        ]);
      } catch {
        // Not an action of this station's version, or no plain acceptance.
      }
    }
    if (answers.length === 0) {
      throw new Error(
        `useBehavior disable: ${id} answers no CALL on ${this.e.host.ocppVersion} that has an Accepted answer, so there is nothing to disable`,
      );
    }
    const key = ruleOwnerKey(owner);
    this.e.host.behaviors.release((held) => ruleOwnerKey(held) === key);
    const unregister: Array<() => void> = [];
    try {
      for (const [action, response] of answers) {
        unregister.push(
          this.e.host.behaviors.register({
            owner,
            action,
            mode: "replace",
            take: (_call, exchange) => {
              this.e.warn(
                `${action}: answered Accepted without acting (${id} is disabled by the running scenario)`,
              );
              exchange.reply({ ...response });
            },
          } satisfies BehaviorRule),
        );
      }
    } catch (error) {
      for (const off of unregister) off();
      throw error;
    }
  }

  // ---- params -------------------------------------------------------------

  /** The behavior with this id, built-in or loaded. */
  declaredBehavior(id: string): Behavior | undefined {
    return this.e.defaultsById.get(id) ?? this.e.loaded.get(id);
  }

  /** The params layers of `id` over its defaults, oldest first. */
  private layersOf(id: string): JsonObject[] {
    const layers: JsonObject[] = [];
    const selected = this.e.selectionParams.get(id);
    if (selected) layers.push(selected);
    for (const layer of this.e.paramLayers.get(id)?.values() ?? []) {
      layers.push(layer.params);
    }
    return layers;
  }

  /**
   * The params `ctx.params` hands out for `id` now: defaults, the station's
   * selection, then each running scenario's layer (the newest on top).
   * Throws when they do not fit the schema.
   */
  effectiveParams(id: string): JsonObject {
    const behavior = this.declaredBehavior(id);
    return mergeParams(id, behavior?.params, this.layersOf(id));
  }

  /**
   * Set (or, with `undefined`, clear) the params the station's selection gives
   * `id`. Validated with the layers already running; throws and changes
   * nothing on a mismatch. Applies to the contexts made from now on.
   */
  setSelectionParams(id: string, params: JsonObject | undefined): void {
    const behavior = this.declaredBehavior(id);
    if (!behavior) {
      throw new Error(`No behavior with id "${id}" is loaded on this station`);
    }
    const layers: JsonObject[] = params ? [params] : [];
    for (const layer of this.e.paramLayers.get(id)?.values() ?? []) {
      layers.push(layer.params);
    }
    mergeParams(id, behavior.params, layers);
    if (params && Object.keys(params).length > 0) {
      this.e.selectionParams.set(id, params);
    } else {
      this.e.selectionParams.delete(id);
    }
  }

  /**
   * Change the params the station's selection gives a loaded code behavior,
   * in place: the running scenarios' layers and the CALLs it has open are
   * kept; its `main` and hook context restart with the new values (as in a
   * reload, see {@link ChargerEngine.replaceBehavior}). Throws and changes
   * nothing when the params do not fit the schema.
   */
  reselectBehaviorParams(id: string, params: JsonObject | undefined): void {
    const behavior = this.e.loaded.get(id);
    if (!behavior) {
      throw new Error(`No behavior with id "${id}" is loaded on this station`);
    }
    const before = this.e.selectionParams.get(id);
    this.setSelectionParams(id, params);
    try {
      this.replaceBehavior(behavior);
    } catch (error) {
      if (before) this.e.selectionParams.set(id, before);
      else this.e.selectionParams.delete(id);
      throw error;
    }
  }

  /** The params the station's selection gave each behavior, a copy. */
  get selectedParams(): Record<string, JsonObject> {
    return Object.fromEntries(this.e.selectionParams);
  }

  private setParamLayer(
    id: string,
    behavior: Behavior,
    owner: RuleOwner,
    params: JsonObject | undefined,
  ): void {
    const key = ruleOwnerKey(owner);
    const held = this.e.paramLayers.get(id);
    const others = [...(held ?? [])]
      .filter(([otherKey]) => otherKey !== key)
      .map(([, layer]) => layer.params);
    const selected = this.e.selectionParams.get(id);
    mergeParams(id, behavior.params, [
      ...(selected ? [selected] : []),
      ...others,
      ...(params ? [params] : []),
    ]);
    if (!params || Object.keys(params).length === 0) {
      held?.delete(key);
      return;
    }
    const layers = held ?? new Map();
    layers.delete(key);
    layers.set(key, { owner, params });
    this.e.paramLayers.set(id, layers);
  }

  /**
   * The runs that selected dormant behaviors let go (the end of a run): a
   * dormant behavior no owner holds any more stops its `main` and its hooks.
   * Rules are released with `BehaviorRegistry.release`, which the caller does.
   */
  deactivateBehaviors(owned: (owner: RuleOwner) => boolean): void {
    for (const [id, layers] of [...this.e.paramLayers]) {
      for (const [key, layer] of [...layers]) {
        if (owned(layer.owner)) layers.delete(key);
      }
      if (layers.size === 0) this.e.paramLayers.delete(id);
    }
    for (const [id, held] of [...this.e.holders]) {
      for (const [key, owner] of [...held]) if (owned(owner)) held.delete(key);
      if (held.size > 0) continue;
      this.e.holders.delete(id);
      this.e.pendingMains.get(id)?.();
      this.e.pendingMains.delete(id);
      this.e.mainScopes.get(id)?.cancel();
      this.e.mainScopes.delete(id);
      this.e.mainRuns.delete(id);
      this.e.endHookContext(id);
    }
    this.e.refreshHooked();
  }

  private registerRules(
    behavior: Behavior,
    owner: RuleOwner,
    ranks?: ReadonlyMap<string, number>,
  ): void {
    const unregister: Array<() => void> = [];
    try {
      for (const [action, call] of Object.entries(behavior.onCall ?? {})) {
        const rank = ranks?.get(ruleKey(owner, action));
        unregister.push(
          this.e.host.behaviors.register(
            {
              owner,
              action,
              ...(call.match ? { match: call.match } : {}),
              mode: call.mode,
              ...(call.onBusy ? { onBusy: call.onBusy } : {}),
              take: (callInfo, exchange) =>
                this.e.runCall(behavior, call, callInfo, exchange),
            } satisfies BehaviorRule,
            rank === undefined ? undefined : { rank },
          ),
        );
      }
    } catch (error) {
      for (const off of unregister) off();
      throw error;
    }
  }

  /** Unload a behavior: stop its waits, release its rules, settle its open CALLs. */
  unloadBehavior(id: string): boolean {
    const behavior = this.e.loaded.get(id);
    if (!behavior) return false;
    this.e.loaded.delete(id);
    this.e.dormant.delete(id);
    this.e.holders.delete(id);
    this.e.selectionParams.delete(id);
    this.e.paramLayers.delete(id);
    this.e.refreshHooked();
    this.e.endHookContext(id);
    this.e.pendingMains.get(id)?.();
    this.e.pendingMains.delete(id);
    this.e.mainScopes.get(id)?.cancel();
    this.e.mainScopes.delete(id);
    this.e.resumeScopes.get(id)?.cancel();
    this.e.resumeScopes.delete(id);
    for (const scope of [...this.e.callScopes]) {
      if (scope.behaviorId === id) this.e.endScope(scope);
    }
    const open = this.e.host.behaviors.release(
      (owner) => owner.kind === "code" && owner.behaviorId === id,
    );
    for (const exchange of open) {
      this.e.warn(
        `Behavior ${id} was unloaded while ${exchange.action} was unanswered; answering InternalError`,
      );
      exchange.replyError("InternalError", `Behavior ${id} was unloaded`);
    }
    this.e.dispatch({ type: "behavior.unloaded", behaviorId: id });
    return true;
  }

  private resumeWaiting = false;

  /**
   * Run `onResume` once the CSMS has accepted the next BootNotification: the
   * boot gate refuses everything else until then, so a `ctx.send` from
   * `onResume` run any earlier would only be refused. Nothing is sent or
   * changed by waiting.
   */
  resumeAfterBoot(): void {
    this.resumeWaiting = true;
  }

  /** The station's boot was accepted: run the `onResume` that was waiting for it. */
  bootAccepted(): void {
    if (!this.resumeWaiting) return;
    this.resumeWaiting = false;
    this.resume();
  }

  /** Run `onResume` of every loaded behavior now; call it after state was restored. */
  resume(): void {
    for (const behavior of this.e.loaded.values()) {
      if (!behavior.onResume || this.e.dormant.has(behavior.id)) continue;
      this.e.resumeScopes.get(behavior.id)?.cancel();
      const scope = new Scope(behavior.id, false);
      this.e.resumeScopes.set(behavior.id, scope);
      this.e.runDetached(behavior.id, scope, (ctx) => behavior.onResume!(ctx));
    }
  }
}
