// The read-only behavior params projection (#654, for #925): selected / armed /
// active, overrides over defaults, release after a run, stable redacted JSON.
import { afterEach, expect, test } from "bun:test";
import type { BehaviorProjection } from "@ocpp-cp-simulator/contracts/behavior";
import { serializeBehaviorParams } from "../../cp/application/engine/behaviorProjection";
import { runBehavior, type BehaviorRun } from "./runBehavior";
import { definition, startScenario } from "./runScenario";

let run: BehaviorRun | undefined;
afterEach(async () => {
  await run?.dispose();
  run = undefined;
});

const firmware = (r: BehaviorRun): BehaviorProjection =>
  r.cp.engine
    .behaviorParamsProjection()
    .behaviors.find((b) => b.id === "default.firmware")!;
const use = (extra: Record<string, unknown>) => ({
  id: "use",
  type: "useBehavior",
  data: { behaviorId: "default.firmware", ...extra },
});
const wait = { id: "w", type: "delay", data: { delaySeconds: 10 } };

test("default → armed override → released after the run", async () => {
  run = await runBehavior({ version: "1.6" });
  const before = firmware(run);
  expect(before.state).toEqual({
    selected: false,
    armed: false,
    active: true,
    disabled: false,
  });
  expect(before.params.overrides).toEqual([]);

  const scenario = startScenario(
    run,
    definition([use({ params: { stepMs: 500 } }), wait]),
  );
  await run.settle();
  const during = firmware(run);
  expect(during.state.armed).toBe(true);
  expect(during.heldBy.map((h) => h.paramKeys)).toEqual([["stepMs"]]);
  expect(during.params.overrides).toEqual([
    {
      key: "stepMs",
      default: before.params.defaults.stepMs,
      effective: 500,
      source: "scenario",
    },
  ]);

  await scenario.stop();
  await scenario.finished;
  const after = firmware(run);
  expect(after.state.armed).toBe(false);
  expect(after.params.overrides).toEqual([]);
  expect(after.history).toEqual({ armed: 1, released: 1, rearmed: 0 });
});

test("disable: armed but not active", async () => {
  run = await runBehavior({ version: "1.6" });
  startScenario(run, definition([use({ mode: "disable" }), wait]));
  await run.settle();
  expect(firmware(run).state).toEqual({
    selected: false,
    armed: true,
    active: false,
    disabled: true,
  });
});

test("serialization is key-sorted and redacts secret-looking params", async () => {
  run = await runBehavior({ version: "1.6" });
  const projection = run.cp.engine.behaviorParamsProjection();
  const text = serializeBehaviorParams(projection);
  expect(text).toBe(serializeBehaviorParams(JSON.parse(text)));
  const secret = {
    ...projection,
    behaviors: [
      {
        ...projection.behaviors[0]!,
        params: {
          ...projection.behaviors[0]!.params,
          effective: { apiToken: "abc", stepMs: 1 },
        },
      },
    ],
  };
  const out = JSON.parse(serializeBehaviorParams(secret));
  expect(out.behaviors[0].params.effective).toEqual({
    apiToken: "[redacted]",
    stepMs: 1,
  });
});
