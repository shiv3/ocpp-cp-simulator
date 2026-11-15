import type {
  Behavior,
  JsonObject,
} from "@ocpp-cp-simulator/contracts/behavior";
import { describeDefaultBehaviors } from "@ocpp-cp-simulator/core/cp/application/engine/behaviors/index";
import type { PersistedEngineState } from "@ocpp-cp-simulator/core/cp/application/engine/ChargerState";
import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import type { ChargePointInitOptions } from "../types";

/** What the behavior functions need from `CLIChargePointService`. */
export interface BehaviorsHost {
  readonly chargePoint: ChargePoint;
  /** Reassigned by {@link setBehaviors}, so a getter / setter pair. */
  init: ChargePointInitOptions;
}

/**
 * Load behavior code (`--behavior`) onto this charge point. A behavior that
 * cannot load (duplicate id, unmet `requires`) throws; the ones before it
 * stay loaded.
 */
export function loadBehaviors(
  host: BehaviorsHost,
  behaviors: readonly Behavior[],
  params?: Readonly<Record<string, JsonObject>>,
): void {
  applyDefaultParams(host, params);
  for (const behavior of behaviors) {
    const own = params?.[behavior.id];
    host.chargePoint.loadBehavior(
      behavior,
      own === undefined ? {} : { params: own },
    );
  }
}

/** Set (or clear) the params the selection gives the built-in behaviors. */
function applyDefaultParams(
  host: BehaviorsHost,
  params: Readonly<Record<string, JsonObject>> | undefined,
): void {
  const engine = host.chargePoint.engine;
  for (const { id } of describeDefaultBehaviors()) {
    engine.setSelectionParams(id, params?.[id]);
  }
}

/** The engine state that survives a rebuild (see `ChargerEngine.persistable`). */
export function engineStateSnapshot(host: BehaviorsHost): PersistedEngineState {
  return host.chargePoint.engine.persistable();
}

/** Put a {@link engineStateSnapshot} back, before behaviors load. */
export function restoreEngineState(
  host: BehaviorsHost,
  saved: PersistedEngineState,
): void {
  host.chargePoint.engine.restoreState(saved);
}

/**
 * The params `ctx.params` hands the behavior with this id now (defaults,
 * the selection's keys, then any running scenario's). Throws for an id that
 * is neither loaded nor built in.
 */
export function effectiveBehaviorParams(
  host: BehaviorsHost,
  id: string,
): JsonObject {
  return host.chargePoint.engine.effectiveParams(id);
}

/** Ids of the code behaviors loaded on this charge point, in load order. */
export function behaviorIds(host: BehaviorsHost): string[] {
  return [...host.chargePoint.engine.behaviorIds];
}

/**
 * Throws if this station could not load one of `wanted` (the checks a load
 * runs), changing nothing. For a caller that is about to rebuild the station
 * and must find out before it closes the old one.
 */
export function assertBehaviorsLoadable(
  host: BehaviorsHost,
  wanted: readonly Behavior[],
): void {
  for (const behavior of wanted) {
    host.chargePoint.engine.assertLoadable(behavior);
  }
}

/**
 * Make `wanted` the set of code behaviors running here (a run-time
 * selection): the ones loaded and not wanted are unloaded, the wanted ones
 * not loaded yet are loaded after those already running. `selection` is
 * what is recorded as the charge point's `behaviors` (`undefined`: all).
 */
export function setBehaviors(
  host: BehaviorsHost,
  wanted: readonly Behavior[],
  selection: readonly string[] | undefined,
  params?: Readonly<Record<string, JsonObject>>,
): void {
  const engine = host.chargePoint.engine;
  const keep = new Set(wanted.map((b) => b.id));
  const have = new Set(engine.behaviorIds);
  // A behavior kept with other params is changed in place: its `main`
  // restarts with the new values, but the layers of running scenarios and
  // its open CALLs stay.
  const before = engine.selectedParams;
  const changed = [...have].filter(
    (id) =>
      keep.has(id) &&
      JSON.stringify(before[id] ?? null) !==
        JSON.stringify(params?.[id] ?? null),
  );
  applyDefaultParams(host, params);
  for (const id of changed) engine.reselectBehaviorParams(id, params?.[id]);
  // Check first, so a behavior this station cannot run changes nothing.
  for (const behavior of wanted) {
    if (!have.has(behavior.id)) engine.assertLoadable(behavior);
  }
  for (const id of [...have]) {
    if (!keep.has(id)) host.chargePoint.unloadBehavior(id);
  }
  for (const behavior of wanted) {
    if (!have.has(behavior.id)) {
      const own = params?.[behavior.id];
      host.chargePoint.loadBehavior(
        behavior,
        own === undefined ? {} : { params: own },
      );
    }
  }
  host.init = {
    ...host.init,
    ...(selection === undefined
      ? { behaviors: undefined }
      : { behaviors: [...selection] }),
    behaviorParams:
      params && Object.keys(params).length > 0 ? { ...params } : undefined,
  };
}

/**
 * Put new versions of loaded behaviors in their place (a reload), all or
 * none: each is checked before any is replaced, and if one still fails the
 * ones already replaced go back to the version they had.
 */
export function replaceBehaviors(
  host: BehaviorsHost,
  next: readonly Behavior[],
): void {
  const engine = host.chargePoint.engine;
  for (const behavior of next) engine.assertLoadable(behavior);
  const done: Behavior[] = [];
  try {
    for (const behavior of next) {
      const previous = engine.behaviorOf(behavior.id);
      engine.replaceBehavior(behavior);
      if (previous) done.push(previous);
    }
  } catch (error) {
    for (const previous of done.reverse()) {
      try {
        engine.replaceBehavior(previous);
      } catch {
        // The old version ran here a moment ago; if it cannot be put back
        // the original error is still the one to report.
      }
    }
    throw error;
  }
}
