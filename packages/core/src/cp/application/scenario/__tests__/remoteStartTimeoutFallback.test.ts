import { describe, expect, it } from "vitest";

import { ScenarioExecutor } from "../ScenarioExecutor";
import type { ScenarioDefinition } from "../ScenarioTypes";
import { getTemplateById } from "../../../../utils/scenarioTemplates";
import { validateScenarioGraph } from "../../../../scenario/scenarioGraphValidator";

function build(timeout: number): ScenarioDefinition {
  const template = getTemplateById("remote-start-timeout-fallback");
  expect(template).toBeDefined();
  const scenario = template!.createScenario("CP-TMPL", 1);
  const wait = scenario.nodes.find((n) => n.id === "trigger-remote-start")!;
  (wait.data as { timeout: number }).timeout = timeout;
  return scenario;
}

describe("remote-start-timeout-fallback (template using a timeout edge)", () => {
  it("validates without errors", () => {
    const issues = validateScenarioGraph(build(30));
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("runs the timeout edge to Available and completes when no RemoteStart arrives", async () => {
    const statuses: string[] = [];
    const errors: unknown[] = [];
    const executor = new ScenarioExecutor(build(1), {
      onWaitForRemoteStart: () => new Promise<never>(() => {}),
      onStatusChange: async (s: string) => {
        statuses.push(s);
      },
      onError: (e: unknown) => {
        errors.push(e);
      },
    } as never);
    await executor.start();
    expect(errors).toEqual([]);
    expect(statuses).toEqual(["Available"]);
  });
});
