import { describe, expect, it } from "vitest";

import { OCPPStatus } from "../../../domain/types/OcppTypes";
import { matchAutoStart } from "../autoStart";
import {
  ScenarioNodeType,
  type ScenarioDefinition,
  type ScenarioNode,
} from "../ScenarioTypes";

function scenario(
  overrides: Partial<ScenarioDefinition> = {},
  startData: Record<string, unknown> = {},
  extraNodes: ScenarioNode[] = [],
): ScenarioDefinition {
  return {
    id: "s1",
    name: "s1",
    targetType: "connector",
    targetId: 1,
    nodes: [
      {
        id: "start",
        type: ScenarioNodeType.START,
        position: { x: 0, y: 0 },
        data: { label: "Start", ...startData },
      } as ScenarioNode,
      ...extraNodes,
    ],
    edges: [],
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    defaultExecutionMode: "oneshot",
    enabled: true,
    trigger: { type: "manual" },
    ...overrides,
  };
}

const statusTriggerNode = {
  id: "wait",
  type: ScenarioNodeType.STATUS_TRIGGER,
  position: { x: 0, y: 0 },
  data: { label: "Wait", targetStatus: OCPPStatus.Charging },
} as ScenarioNode;

describe("matchAutoStart", () => {
  it.each([
    ["a manual scenario on connect", scenario(), "connect", null, true],
    [
      "a scenario without trigger on connect",
      scenario({ trigger: undefined }),
      "connect",
      null,
      true,
    ],
    [
      "a disabled scenario",
      scenario({ enabled: false }),
      "connect",
      null,
      false,
    ],
    [
      "a statusChange-triggered scenario",
      scenario({ trigger: { type: "statusChange" } }),
      "connect",
      null,
      false,
    ],
    [
      "a scenario with a StatusTrigger node",
      scenario({}, {}, [statusTriggerNode]),
      "connect",
      null,
      false,
    ],
    [
      "a connect scenario on a status trigger",
      scenario(),
      "status",
      OCPPStatus.Charging,
      false,
    ],
    [
      "a status scenario on its target status",
      scenario({}, { triggerOn: "status", targetStatus: OCPPStatus.Charging }),
      "status",
      OCPPStatus.Charging,
      true,
    ],
    [
      "a status scenario on another status",
      scenario({}, { triggerOn: "status", targetStatus: OCPPStatus.Charging }),
      "status",
      OCPPStatus.Preparing,
      false,
    ],
    [
      "a status scenario without target status",
      scenario({}, { triggerOn: "status" }),
      "status",
      OCPPStatus.Charging,
      false,
    ],
    [
      "a misshapen scenario without nodes",
      scenario({ nodes: undefined as unknown as ScenarioNode[] }),
      "connect",
      null,
      false,
    ],
  ] as const)("%s → %s", (_label, definition, trigger, status, expected) => {
    expect(matchAutoStart(definition, trigger, status) !== null).toBe(expected);
  });

  it("keys on the graph, not on updatedAt", () => {
    const a = matchAutoStart(scenario(), "connect", null);
    const b = matchAutoStart(
      scenario({ updatedAt: "2026-10-03T00:00:00.000Z" }),
      "connect",
      null,
    );
    const c = matchAutoStart(
      scenario({}, { label: "Renamed start" }),
      "connect",
      null,
    );

    expect(a?.key).toBe(b?.key);
    expect(a?.key).not.toBe(c?.key);
  });
});
