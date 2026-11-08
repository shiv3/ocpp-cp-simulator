// #444, #455: each resilience template, run by a real ScenarioExecutor against
// the fake CSMS (the operator's fault injected as the template says), ends
// with every assertion passed; the same assertions fail on a transcript
// without the recovery. The frames are those of the run, as the daemon's
// transcript holds them.
import { describe, expect, test } from "bun:test";
import { evaluateAssertions } from "../../cp/application/verification/ScenarioAssertions";
import type { AssertionSpec } from "../../cp/application/scenario/ScenarioTypes";
import type { Frame } from "../../cp/application/verification/ocpp";
import { scenarioTemplates } from "../../utils/scenarioTemplates";
import type { WireFrame } from "./FakeCsms";
import { Rig } from "./rig";
import { runTemplate } from "./scenarioCases";

const IDS = scenarioTemplates
  .map((t) => t.id)
  .filter((id) => id.startsWith("resilience-"));

function toFrames(frames: readonly WireFrame[]): Frame[] {
  return frames.flatMap((f, i): Frame[] => {
    const direction = f.dir === "CP>" ? "sent" : "received";
    const base = {
      direction,
      uniqueId: f.id,
      payload: f.payload,
      timestamp: new Date(i * 1000).toISOString(),
      raw: JSON.stringify(f),
    } as const;
    if (f.kind === "call") {
      return [{ kind: "call", action: f.action ?? "", ...base }];
    }
    if (f.kind === "result") return [{ kind: "callresult", ...base }];
    return [];
  });
}

function assertionsOf(id: string): AssertionSpec[] {
  const def = scenarioTemplates
    .find((t) => t.id === id)!
    .createScenario("CP", 1);
  return (def.assertions ?? []) as AssertionSpec[];
}

describe("resilience templates end in a passing verdict (#444)", () => {
  test("the set is the six shipped", () => {
    expect(IDS.sort()).toEqual([
      "resilience-authorization-rejected",
      "resilience-communication-loss-recovery",
      "resilience-connector-fault-recovery",
      "resilience-ev-disconnect-recovery",
      "resilience-power-loss-recovery",
      "resilience-temporary-unavailable-recovery",
    ]);
  });

  for (const id of IDS) {
    test.concurrent(
      id,
      async () => {
        const rig = await Rig.create({ version: "1.6" });
        try {
          const first = rig.csms.frames.length;
          await runTemplate(rig, id);
          const frames = toFrames(rig.csms.frames.slice(first));
          const results = evaluateAssertions(assertionsOf(id), frames);
          expect(results.length).toBeGreaterThan(0);
          expect(results.filter((r) => r.status !== "passed")).toEqual([]);
          // The assertions are not vacuous: none holds on an empty run.
          const empty = evaluateAssertions(assertionsOf(id), []);
          expect(empty.some((r) => r.status === "failed")).toBe(true);
        } finally {
          await rig.dispose();
        }
      },
      120_000,
    );
  }
});
