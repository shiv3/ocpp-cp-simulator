import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import type { ReplaceOutcome } from "../../behavior/BehaviorLibrary";
import type { CLIChargePointService } from "../../service";

/**
 * The library listener: put the reloaded behaviors of one file on every
 * charge point running them. All or none on each charge point: every new
 * version is checked first, and a failure part-way puts the old versions back.
 */
export function replaceBehaviorsEverywhere(
  services: ReadonlyMap<string, CLIChargePointService>,
  behaviors: readonly Behavior[],
): ReplaceOutcome {
  let applied = 0;
  const failures: string[] = [];
  for (const [cpId, svc] of services) {
    const running = svc.behaviorIds();
    const mine = behaviors.filter((b) => running.includes(b.id));
    if (mine.length === 0) continue;
    try {
      svc.replaceBehaviors(mine);
      applied++;
    } catch (error) {
      failures.push(
        `${cpId} keeps the old version of ${mine.map((b) => b.id).join(", ")}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { applied, failures };
}
