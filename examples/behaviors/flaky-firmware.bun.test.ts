// The test that ships with the template: same seed, same frames. Copy it with
// the behavior. Runs under `bun test` (the harness uses Bun.serve).
import { afterEach, describe, expect, test } from "bun:test";
import {
  runBehavior,
  type BehaviorRun,
} from "../../packages/core/src/test/behavior/runBehavior";
import { flakyFirmware } from "./flaky-firmware";

let runs: BehaviorRun[] = [];
afterEach(async () => {
  for (const r of runs) await r.dispose();
  runs = [];
});

async function update(
  seed: string,
  version: "1.6" | "2.0.1" = "1.6",
): Promise<BehaviorRun> {
  const run = await runBehavior({
    version,
    seed,
    behaviors: [flakyFirmware],
  });
  runs.push(run);
  run.callNoWait(
    "UpdateFirmware",
    version === "1.6"
      ? {
          location: "http://fw.example/a.bin",
          retrieveDate: "2020-01-01T00:00:00Z",
        }
      : {
          requestId: 7,
          firmware: {
            location: "http://fw.example/a.bin",
            retrieveDateTime: "2020-01-01T00:00:00Z",
          },
        },
  );
  await run.advanceInSteps(20_000);
  return run;
}

const statuses = (run: BehaviorRun): string[] =>
  run
    .callsOf("FirmwareStatusNotification")
    .map((f) => (f.payload as { status: string }).status);

describe("flaky-firmware", () => {
  test("the same seed gives the same frames", async () => {
    const a = await update("seed-1");
    const b = await update("seed-1");
    expect(a.effectHash()).toBe(b.effectHash());
    expect(statuses(a)).toEqual(statuses(b));
  });

  test("walks Downloading, Downloaded, Installing, then a final status", async () => {
    const run = await update("seed-1");
    const seen = statuses(run);
    expect(seen.slice(0, 3)).toEqual([
      "Downloading",
      "Downloaded",
      "Installing",
    ]);
    expect(["Installed", "InstallationFailed"]).toContain(seen[3]!);
    expect(seen).toHaveLength(4);
  });

  test("some seed fails the install and some succeeds", async () => {
    const finals = new Set<string>();
    for (let i = 0; i < 12 && finals.size < 2; i++) {
      finals.add(statuses(await update(`s${i}`)).at(-1)!);
    }
    expect([...finals].sort()).toEqual(["InstallationFailed", "Installed"]);
  });

  test("keeps its count in ctx.state, which the engine holds", async () => {
    const run = await update("seed-1");
    expect(run.cp.engine.snapshot().behaviors["flaky-firmware"]).toMatchObject({
      attempts: 1,
    });
  });

  test("answers 2.0.1 with a status", async () => {
    const run = await update("seed-1", "2.0.1");
    expect(statuses(run)[0]).toBe("Downloading");
  });
});
