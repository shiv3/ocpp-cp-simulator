import { createContext, useContext } from "react";
import type { BehaviorParams } from "@ocpp-cp-simulator/contracts/behavior";
import { describeDefaultBehaviors } from "@ocpp-cp-simulator/core/cp/application/engine/behaviors/index";

/** Behavior id to its params declaration (schema and defaults). */
export type BehaviorParamsCatalog = ReadonlyMap<string, BehaviorParams>;

/** The built-in `default.*` behaviors that declare params. */
export const BUILTIN_PARAMS_CATALOG: BehaviorParamsCatalog = new Map(
  describeDefaultBehaviors().flatMap((behavior) =>
    behavior.params ? [[behavior.id, behavior.params] as const] : [],
  ),
);

/**
 * What the `useBehavior` form knows about behaviors' params. The built-in ones
 * are always known; a host that has the daemon's `behavior.list` (loaded
 * behaviors and their schemas) can provide the rest. A behavior the catalogue
 * does not know is edited as raw JSON.
 */
export const BehaviorParamsCatalogContext =
  createContext<BehaviorParamsCatalog>(BUILTIN_PARAMS_CATALOG);

export function useBehaviorParamsCatalog(): BehaviorParamsCatalog {
  return useContext(BehaviorParamsCatalogContext);
}
