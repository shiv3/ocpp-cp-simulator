import type { ChargePoint } from "@ocpp-cp-simulator/core/cp/domain/charge-point/ChargePoint";
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import { behaviorsOfModule } from "@ocpp-cp-simulator/core/cp/application/engine/behaviorModule";

/** The body of LocalChargePointService.loadBehaviorBundle (see its JSDoc). */
export async function loadBehaviorBundleInto(
  cp: ChargePoint,
  bundle: Blob | string,
): Promise<string[]> {
  const blob =
    typeof bundle === "string"
      ? new Blob([bundle], { type: "text/javascript" })
      : bundle.type === "text/javascript"
        ? bundle
        : new Blob([bundle], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    const mod: unknown = await import(/* @vite-ignore */ url);
    const behaviors = behaviorsOfModule("behavior bundle", mod);
    const running = new Set(cp.engine.behaviorIds);
    const seen = new Set<string>();
    for (const behavior of behaviors) {
      if (seen.has(behavior.id)) {
        throw new Error(`behavior id "${behavior.id}" is given twice`);
      }
      seen.add(behavior.id);
    }
    // Check every behavior, replaced and new alike, before changing anything.
    for (const behavior of behaviors) cp.engine.assertLoadable(behavior);
    const added: string[] = [];
    const replaced: Behavior[] = [];
    try {
      for (const behavior of behaviors) {
        if (running.has(behavior.id)) {
          const previous = cp.engine.behaviorOf(behavior.id);
          cp.engine.replaceBehavior(behavior);
          if (previous) replaced.push(previous);
        } else {
          cp.loadBehavior(behavior);
          added.push(behavior.id);
        }
      }
    } catch (error) {
      // All or nothing: what was added goes, what was replaced comes back.
      for (const behaviorId of added) cp.unloadBehavior(behaviorId);
      for (const previous of replaced.reverse()) {
        try {
          cp.engine.replaceBehavior(previous);
        } catch {
          // The original error is the one to report.
        }
      }
      throw error;
    }
    return behaviors.map((behavior) => behavior.id);
  } finally {
    URL.revokeObjectURL(url);
  }
}
