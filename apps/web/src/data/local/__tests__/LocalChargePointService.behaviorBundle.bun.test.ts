import { afterEach, describe, expect, test } from "bun:test";
import {
  runBehavior,
  type BehaviorRun,
} from "@ocpp-cp-simulator/core/test/behavior/runBehavior";
import { LocalChargePointService } from "../LocalChargePointService";

let runs: BehaviorRun[] = [];
afterEach(async () => {
  for (const run of runs) await run.dispose();
  runs = [];
});

/** `loadBehaviorBundle` needs only the charge point it is given. */
const load = (cp: unknown, code: string): Promise<string[]> =>
  LocalChargePointService.prototype.loadBehaviorBundle.call(
    {
      getExistingChargePointOrThrow: () => cp,
    } as unknown as LocalChargePointService,
    "x",
    code,
  );

const loadedMarker = (run: BehaviorRun, id: string): unknown =>
  (
    run.cp.engine as unknown as {
      behaviorOf(id: string): { marker?: unknown } | undefined;
    }
  ).behaviorOf(id)?.marker;

describe("loadBehaviorBundle is all or nothing", () => {
  test("a new behavior the station cannot take leaves the replaced one as it was", async () => {
    const run = await runBehavior({
      version: "1.6",
      behaviors: [{ api: 1, id: "a", marker: "v1" } as never],
    });
    runs.push(run);
    const bundle = `export default [
      { api: 1, id: "a", marker: "v2" },
      { api: 1, id: "fresh", requires: ["ocpp2.x"] },
    ];`;
    await expect(load(run.cp, bundle)).rejects.toThrow();
    expect(loadedMarker(run, "a")).toBe("v1");
    expect(run.cp.engine.behaviorIds).toEqual(["a"]);
  });

  test("a bundle that names an id twice is refused whole", async () => {
    const run = await runBehavior({ version: "1.6", behaviors: [] });
    runs.push(run);
    await expect(
      load(
        run.cp,
        `export default [{ api: 1, id: "d" }, { api: 1, id: "d" }];`,
      ),
    ).rejects.toThrow(/twice/);
    expect(run.cp.engine.behaviorIds).toEqual([]);
  });
});
