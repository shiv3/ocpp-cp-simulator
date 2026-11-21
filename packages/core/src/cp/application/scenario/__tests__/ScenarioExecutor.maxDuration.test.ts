import { describe, expect, it } from "vitest";
import { VirtualClock } from "../../../shared/clock";
import { ScenarioExecutor } from "../ScenarioExecutor";
import type { ScenarioDefinition } from "../ScenarioTypes";
import { ScenarioNodeType } from "../ScenarioTypes";
import { linearScenario, node } from "./scenarioFixtures";

/**
 * `maxDurationSeconds` (schema 1.13): the run ends normally once that much
 * station-clock time has passed, however long its nodes would still take.
 */

const longDelay = (maxDurationSeconds?: number): ScenarioDefinition => ({
  ...linearScenario("bounded", []),
  nodes: [
    node("start", ScenarioNodeType.START, { label: "Start" }),
    node("wait", ScenarioNodeType.DELAY, { label: "Wait", delaySeconds: 600 }),
    node("after", ScenarioNodeType.SET_STATE, {
      label: "After",
      key: "after",
      value: true,
    }),
    node("end", ScenarioNodeType.END, { label: "End" }),
  ],
  edges: [
    { id: "e1", source: "start", target: "wait" },
    { id: "e2", source: "wait", target: "after" },
    { id: "e3", source: "after", target: "end" },
  ],
  ...(maxDurationSeconds === undefined ? {} : { maxDurationSeconds }),
});

async function runFor(
  scenario: ScenarioDefinition,
  advanceSeconds: number,
): Promise<{ executor: ScenarioExecutor; executed: string[] }> {
  const clock = new VirtualClock();
  const executed: string[] = [];
  const executor = new ScenarioExecutor(
    scenario,
    { onNodeExecute: (id) => executed.push(id) },
    undefined,
    { clock },
  );
  const running = executor.start();
  await clock.advanceBy(advanceSeconds * 1000);
  await running;
  return { executor, executed };
}

describe("maxDurationSeconds", () => {
  it("ends the run normally at the bound, cutting a long delay short", async () => {
    const { executor, executed } = await runFor(longDelay(30), 31);
    const ctx = executor.getContext();
    expect(ctx.state).toBe("completed");
    expect(ctx.endedBy).toBe("maxDuration");
    expect(executed).toContain("wait");
    expect(executed).not.toContain("after");
  });

  it("does nothing to a run that ends before the bound", async () => {
    const scenario = longDelay(5000);
    const { executor, executed } = await runFor(scenario, 601);
    const ctx = executor.getContext();
    expect(ctx.state).toBe("completed");
    expect(ctx.endedBy).toBeUndefined();
    expect(executed).toContain("after");
  });

  it("is off without the field, and at 0", async () => {
    for (const bound of [undefined, 0]) {
      const { executor, executed } = await runFor(longDelay(bound), 601);
      expect(executor.getContext().endedBy).toBeUndefined();
      expect(executed).toContain("after");
    }
  });
});
