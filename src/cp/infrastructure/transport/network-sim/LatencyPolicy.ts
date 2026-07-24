import { draw } from "./SeededRng";
import { NETWORK_SIM_LIMITS, type ResolvedNetworkSimConfig } from "./config";
import type { FrameContext } from "./FrameContext";

export function evaluateDelayMs(
  ctx: FrameContext,
  rules: ResolvedNetworkSimConfig["rules"],
  rngFor: (ruleId: string) => () => number,
): number {
  let total = 0;

  for (const ruleId of Object.keys(rules)) {
    const rule = rules[ruleId];
    if (rule.type !== "latency") {
      continue;
    }

    const direction = rule.direction ?? "both";
    if (direction !== "both" && direction !== ctx.direction) {
      continue;
    }

    if (
      rule.match !== undefined &&
      (ctx.action === undefined || !rule.match.actions.includes(ctx.action))
    ) {
      continue;
    }

    total += rule.delayMs;
    if (rule.jitterMs !== undefined) {
      total += draw(rngFor(ruleId), rule.jitterMs);
    }
  }

  return Math.min(NETWORK_SIM_LIMITS.maxDelayMs, total);
}
