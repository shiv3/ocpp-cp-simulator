import { describe, expect, it } from "bun:test";

import { shouldReleaseEvSettingsOverride } from "../service";
import type { ScenarioDefinition } from "../../cp/application/scenario/ScenarioTypes";

/**
 * The truth table for releasing a connector's EV settings override (#105, #314).
 *
 * This exists because the rule has three conditions that must hold at once, and
 * two formulations satisfying only two of them have shipped: one released an
 * explicit operator override a scenario never set, the other skipped a run's
 * own cleanup because that run's definition was still installed. Neither was
 * caught by an integration test, because the combination each got wrong was the
 * one nothing exercised. Six lines of table cover every combination.
 */
function def(evSettings?: Record<string, unknown>): ScenarioDefinition {
  return {
    id: "s",
    name: "s",
    targetType: "connector",
    targetId: 1,
    nodes: [],
    edges: [],
    ...(evSettings ? { evSettings } : {}),
  } as unknown as ScenarioDefinition;
}

describe("shouldReleaseEvSettingsOverride (#105, #314)", () => {
  it("covers every combination of declaration and replacement", () => {
    const mine = def({ targetSoc: 50 });
    const minePlain = def();
    const other = def({ targetSoc: 80 });
    const otherPlain = def();

    expect({
      // 1. Not mine to release: a run that declared nothing never set the
      //    override, so an explicit `set_ev_settings` survives it (#105).
      plainRunStillInstalled: shouldReleaseEvSettingsOverride(
        minePlain,
        minePlain,
      ),
      plainRunReplaced: shouldReleaseEvSettingsOverride(minePlain, other),
      plainRunRemoved: shouldReleaseEvSettingsOverride(minePlain, undefined),

      // 3. Ordinary completion: my definition is still installed, because
      //    nothing removes it when a run ends. This is the case presence could
      //    not express, and the one that shipped broken.
      declaredRunStillInstalled: shouldReleaseEvSettingsOverride(mine, mine),

      // …and the scenario removed outright: nobody claimed anything.
      declaredRunRemoved: shouldReleaseEvSettingsOverride(mine, undefined),

      // 2. Replaced by a definition that claimed the override for itself:
      //    clearing would unmark a live one.
      declaredRunReplacedByClaiming: shouldReleaseEvSettingsOverride(
        mine,
        other,
      ),

      // Replaced by one that claimed nothing: still mine to release.
      declaredRunReplacedByPlain: shouldReleaseEvSettingsOverride(
        mine,
        otherPlain,
      ),
    }).toEqual({
      plainRunStillInstalled: false,
      plainRunReplaced: false,
      plainRunRemoved: false,
      declaredRunStillInstalled: true,
      declaredRunRemoved: true,
      declaredRunReplacedByClaiming: false,
      declaredRunReplacedByPlain: true,
    });
  });

  it("asks identity, not presence", () => {
    // Two definitions that both declare EV settings and are otherwise equal.
    // Presence cannot tell them apart; identity can, and the answers differ.
    const mine = def({ targetSoc: 50 });
    const twin = def({ targetSoc: 50 });
    expect(shouldReleaseEvSettingsOverride(mine, mine)).toBe(true);
    expect(shouldReleaseEvSettingsOverride(mine, twin)).toBe(false);
  });
});
