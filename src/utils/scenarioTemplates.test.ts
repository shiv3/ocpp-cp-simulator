import { describe, expect, it } from "vitest";

import { scenarioTemplates } from "./scenarioTemplates";
import {
  isScenarioDefinitionShape,
  ScenarioNodeType,
  type ScenarioDefinition,
} from "../cp/application/scenario/ScenarioTypes";

const KNOWN_NODE_TYPES = new Set<string>(Object.values(ScenarioNodeType));

/**
 * Every OCPP 1.6 Core certification scenario the brief for issue #110's
 * first slice asks for. Fails loudly (rather than just "some templates
 * exist") until each one is authored and registered.
 */
const EXPECTED_CERT16_IDS = [
  "cert16-tc001-cold-boot",
  "cert16-tc003-charging-plugin-first",
  "cert16-tc004-charging-id-first",
  "cert16-tc005-ev-side-disconnect",
  "cert16-tc010-remote-start",
  "cert16-tc011-remote-start-stop",
  "cert16-tc012-remote-stop",
  "cert16-tc013-hard-reset",
  "cert16-tc014-soft-reset",
  "cert16-tc017-unlock-occupied",
  "cert16-tc018-unlock-failure",
  "cert16-tc019-get-configuration-all",
  "cert16-tc019-get-configuration-key",
  "cert16-tc021-change-configuration",
  "cert16-tc031-unlock-unknown-connector",
  "cert16-tc061-clear-cache",
  "cert16-tc064-data-transfer",
  "cert16-tc024-lock-failure",
  "cert16-reservation-basic",
];

/** BFS from the single start node; true if any END node is reachable. */
function canReachEndNode(scenario: ScenarioDefinition): boolean {
  const startNode = scenario.nodes.find(
    (n) => n.type === ScenarioNodeType.START,
  );
  if (!startNode) return false;

  const nodeById = new Map(scenario.nodes.map((n) => [n.id, n]));
  const targetsBySource = new Map<string, string[]>();
  for (const edge of scenario.edges) {
    const list = targetsBySource.get(edge.source) ?? [];
    list.push(edge.target);
    targetsBySource.set(edge.source, list);
  }

  const visited = new Set<string>();
  const queue: string[] = [startNode.id];
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);

    const node = nodeById.get(currentId);
    if (node?.type === ScenarioNodeType.END) return true;

    for (const nextId of targetsBySource.get(currentId) ?? []) {
      if (!visited.has(nextId)) queue.push(nextId);
    }
  }
  return false;
}

describe("scenarioTemplates registry", () => {
  it("has unique template ids", () => {
    const ids = scenarioTemplates.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("registers every cert16 Core certification scenario from the brief", () => {
    const ids = scenarioTemplates.map((t) => t.id);
    for (const expectedId of EXPECTED_CERT16_IDS) {
      expect(ids).toContain(expectedId);
    }
  });

  for (const template of scenarioTemplates) {
    describe(`template: ${template.id}`, () => {
      const scenario = template.createScenario("CP-TEST", 1);

      it("instantiates via createScenario() into a valid ScenarioDefinition shape", () => {
        expect(isScenarioDefinitionShape(scenario)).toBe(true);
      });

      it("uses only known ScenarioNodeType values", () => {
        for (const node of scenario.nodes) {
          expect(KNOWN_NODE_TYPES.has(node.type as string)).toBe(true);
        }
      });

      it("has edges that only reference existing node ids", () => {
        const nodeIds = new Set(scenario.nodes.map((n) => n.id));
        for (const edge of scenario.edges) {
          expect(nodeIds.has(edge.source)).toBe(true);
          expect(nodeIds.has(edge.target)).toBe(true);
        }
      });

      it("has exactly one start node", () => {
        const startNodes = scenario.nodes.filter(
          (n) => n.type === ScenarioNodeType.START,
        );
        expect(startNodes).toHaveLength(1);
      });

      // Certification scenarios (this task's deliverable) must always be
      // able to walk to completion — a cert run has to finish so the
      // operator/CSMS log shows a bounded pass/fail. Pre-existing
      // non-cert templates aren't held to this: e.g.
      // status-triggered-actions is an intentional Heartbeat loop with
      // an unreachable End node left over from the editor, stopped via
      // the Stop button rather than by walking to completion — a
      // pre-existing quirk out of scope for this change.
      if (template.id.startsWith("cert16-")) {
        it("can reach an end node by walking edges from start", () => {
          expect(canReachEndNode(scenario)).toBe(true);
        });
      }
    });
  }
});
