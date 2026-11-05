import { draw } from "./SeededRng";
import { NETWORK_SIM_LIMITS, type ResolvedNetworkSimConfig } from "./config";
import type { FrameContext } from "./FrameContext";

export function evaluateDelayMs(
  ctx: FrameContext,
  rules: ResolvedNetworkSimConfig["rules"],
  rngFor: (ruleId: string) => () => number,
): number {
  // Delegates to the with-logging variant to keep the matching / rng-draw
  // logic in one place; the two must consume the PRNG identically.
  return evaluateDelayMsWithLogging(ctx, rules, rngFor).delayMs;
}

/**
 * Evaluate delay and log matching rules. Returns the total delay and an array
 * of matched rule IDs and their individual delays.
 */
export function evaluateDelayMsWithLogging(
  ctx: FrameContext,
  rules: ResolvedNetworkSimConfig["rules"],
  rngFor: (ruleId: string) => () => number,
): {
  delayMs: number;
  matchedRules: Array<{ ruleId: string; delayMs: number }>;
} {
  let total = 0;
  const matchedRules: Array<{ ruleId: string; delayMs: number }> = [];

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

    let ruleDelay = rule.delayMs;
    if (rule.jitterMs !== undefined) {
      ruleDelay += draw(rngFor(ruleId), rule.jitterMs);
    }

    matchedRules.push({ ruleId, delayMs: ruleDelay });
    total += ruleDelay;
  }

  const finalDelay = Math.min(NETWORK_SIM_LIMITS.maxDelayMs, total);
  return { delayMs: finalDelay, matchedRules };
}
