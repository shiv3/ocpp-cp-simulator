import { describe, expect, it } from "vitest";

import { ScenarioExecutor } from "../ScenarioExecutor";
import { getTemplateById } from "../../../../utils/scenarioTemplates";
import { validateScenarioGraph } from "../../../../scenario/scenarioGraphValidator";

const scenario = () => {
  const template = getTemplateById("parallel-heartbeat-session");
  expect(template).toBeDefined();
  return template!.createScenario("CP-TMPL", 1);
};

describe("parallel-heartbeat-session (template using parallel + join)", () => {
  it("validates without errors", () => {
    const issues = validateScenarioGraph(scenario());
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(issues.map((i) => i.code)).not.toContain("parallelWithoutJoin");
    expect(issues.map((i) => i.code)).not.toContain("joinWithoutParallel");
  });

  it("runs both branches and ends after the join", async () => {
    const events: string[] = [];
    const errors: unknown[] = [];
    const executor = new ScenarioExecutor(scenario(), {
      onSendNotification: async (type: string) => {
        events.push(`notify:${type}`);
      },
      onDelay: async () => {},
      onWaitForRemoteStart: async () => "TAG-1",
      onStartTransaction: async () => {
        events.push("startTx");
      },
      onStartAutoMeterValue: () => {
        events.push("autoMeter");
      },
      onSetMeterValue: () => {},
      onSendMeterValue: async () => {},
      onError: (e: unknown) => {
        errors.push(e);
      },
    } as never);
    await executor.start();
    expect(errors).toEqual([]);
    expect(events.filter((e) => e === "notify:Heartbeat")).toHaveLength(3);
    expect(events).toContain("startTx");
  });
});
