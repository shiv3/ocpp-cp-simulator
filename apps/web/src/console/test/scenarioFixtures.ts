import type { Edge } from "@xyflow/react";

import {
  ScenarioNodeType,
  type ScenarioDefinition,
  type ScenarioNode,
} from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";

function node(
  id: string,
  type: ScenarioNodeType,
  label: string,
  data: Record<string, unknown> = {},
): ScenarioNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label, ...data } as ScenarioNode["data"],
  };
}

/**
 * START → plug → status → (fork) ┬ charge → meter → END   ("Charge path")
 *                                └ wait                → END (Branch B)
 * Five steps: two in main (the fork node `status` last), then a branch of two
 * and a branch of one.
 */
export function forkScenario(
  overrides: Partial<ScenarioDefinition> = {},
): ScenarioDefinition {
  const nodes = [
    node("start", ScenarioNodeType.START, "Start"),
    node("plug", ScenarioNodeType.CONNECTOR_PLUG, "Connector Plug", {
      action: "plugin",
    }),
    node("status", ScenarioNodeType.STATUS_CHANGE, "Status Change", {
      status: "Preparing",
    }),
    node("charge", ScenarioNodeType.TRANSACTION, "Charge path", {
      action: "start",
      tagId: "TAG1",
    }),
    node("meter", ScenarioNodeType.METER_VALUE, "Meter Value", {
      value: 100,
    }),
    node("wait", ScenarioNodeType.DELAY, "Delay", { delaySeconds: 5 }),
    node("end", ScenarioNodeType.END, "End"),
  ];
  const pairs: Array<[string, string]> = [
    ["start", "plug"],
    ["plug", "status"],
    ["status", "charge"],
    ["status", "wait"],
    ["charge", "meter"],
    ["meter", "end"],
    ["wait", "end"],
  ];
  const edges: Edge[] = pairs.map(([source, target]) => ({
    id: `${source}->${target}`,
    source,
    target,
  }));
  return {
    id: "s1",
    name: "Fork demo",
    targetType: "connector",
    targetId: 1,
    nodes,
    edges,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const stamps = {
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/**
 * START → route (switch, cases ["a"]) ┬ case-0  → notify → END
 *                                     ├ default → store  → END
 *                                     └ (no handle) → late → END
 * `validateScenarioGraph`: unpickableHandle on `route` (edge `e-nohandle`),
 * unreachable `late`, noCallHeld on `notify` (its requestId reads the CALL).
 */
export function messyScenario(): ScenarioDefinition {
  return {
    id: "messy-1",
    name: "Messy",
    targetType: "connector",
    targetId: 1,
    nodes: [
      node("start", ScenarioNodeType.START, "Start"),
      node("route", ScenarioNodeType.SWITCH, "Route", {
        value: "a",
        cases: ["a"],
      }),
      node("notify", ScenarioNodeType.NOTIFY, "Notify", {
        kind: "status",
        status: "Available",
        requestId: { $from: "call.payload.requestId" },
      }),
      node("store", ScenarioNodeType.SET_STATE, "Store", {
        key: "k",
        value: "v",
      }),
      node("late", ScenarioNodeType.DELAY, "Late delay", { delaySeconds: 1 }),
      node("end", ScenarioNodeType.END, "End"),
    ],
    edges: [
      { id: "e-start", source: "start", target: "route" },
      {
        id: "e-case0",
        source: "route",
        target: "notify",
        sourceHandle: "case-0",
      },
      {
        id: "e-default",
        source: "route",
        target: "store",
        sourceHandle: "default",
      },
      { id: "e-nohandle", source: "route", target: "late" },
      { id: "e-notify-end", source: "notify", target: "end" },
      { id: "e-store-end", source: "store", target: "end" },
      { id: "e-late-end", source: "late", target: "end" },
    ],
    ...stamps,
  };
}

/**
 * START → route (switch, cases ["a"]) ┬ case-0  → first  → END
 *                                     ├ case-0  → second → END (`e-dup`)
 *                                     └ default → END
 * `validateScenarioGraph`: duplicateHandle on `route` (edge `e-dup`, drawn
 * as the second lane's fork edge), unreachable `second`.
 */
export function duplicateHandleScenario(): ScenarioDefinition {
  return {
    id: "dup-1",
    name: "Duplicate handle",
    targetType: "connector",
    targetId: 1,
    nodes: [
      node("start", ScenarioNodeType.START, "Start"),
      node("route", ScenarioNodeType.SWITCH, "Route", {
        value: "a",
        cases: ["a"],
      }),
      node("first", ScenarioNodeType.DELAY, "First", { delaySeconds: 1 }),
      node("second", ScenarioNodeType.DELAY, "Second", { delaySeconds: 1 }),
      node("end", ScenarioNodeType.END, "End"),
    ],
    edges: [
      { id: "e-start", source: "start", target: "route" },
      {
        id: "e-first",
        source: "route",
        target: "first",
        sourceHandle: "case-0",
      },
      {
        id: "e-dup",
        source: "route",
        target: "second",
        sourceHandle: "case-0",
      },
      {
        id: "e-default",
        source: "route",
        target: "end",
        sourceHandle: "default",
      },
      { id: "e-first-end", source: "first", target: "end" },
      { id: "e-second-end", source: "second", target: "end" },
    ],
    ...stamps,
  };
}
