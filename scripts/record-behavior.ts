// Record a run of a behavior as a scenario (#654, step 2):
//
//   bun scripts/record-behavior.ts default.firmware \
//     --action UpdateFirmware --payload '{"location":"http://x/f.bin","retrieveDate":"2020-01-01T00:00:00Z"}' \
//     --params '{"stepMs":5000,"failAt":"InstallationFailed"}' --seed demo \
//     --out recorded.json --diagram recorded.mmd
//
// `<behavior>` is a built-in `default.*` id or the path of a behavior module
// (default export: a behavior). The scenario carries `recordedFrom`
// { behaviorId, commit, seed, version }. The run is on the virtual clock, so
// it takes no real time. See docs/analyses/scenario-or-behavior.md,
// "Record a run as a scenario".
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type {
  Behavior,
  JsonObject,
} from "@ocpp-cp-simulator/contracts/behavior";
import { behaviorsOfModule } from "../packages/core/src/cp/application/engine/behaviorModule";
import { recordBehavior } from "../packages/core/src/test/behavior/recordBehavior";
import type { WireVersion } from "../packages/core/src/test/goldenWire/FakeCsms";
import { appVersion } from "../apps/cli/src/appVersion";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    action: { type: "string" },
    payload: { type: "string", default: "{}" },
    params: { type: "string" },
    seed: { type: "string", default: "record" },
    version: { type: "string", default: "1.6" },
    horizon: { type: "string" },
    step: { type: "string" },
    out: { type: "string" },
    diagram: { type: "string" },
  },
});

const target = positionals[0];
if (!target || !values.action) {
  console.error(
    "usage: bun scripts/record-behavior.ts <default.* id | module path> --action <CSMS action> [--payload JSON] [--params JSON] [--seed S] [--version 1.6|2.0.1|2.1] [--horizon MS] [--step MS] [--out FILE] [--diagram FILE]",
  );
  process.exit(2);
}

let behavior: Behavior | string = target;
if (!target.startsWith("default.")) {
  const loaded = behaviorsOfModule(target, await import(resolve(target)));
  if (loaded.length !== 1) {
    console.error(
      `${target}: expected exactly one behavior, found ${loaded.length}`,
    );
    process.exit(2);
  }
  behavior = loaded[0] as Behavior;
}

let commit = process.env.APP_COMMIT ?? "unknown";
if (commit === "unknown") {
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Not a checkout: the version alone identifies the build.
  }
}

const recording = await recordBehavior({
  behavior,
  version: values.version as WireVersion,
  trigger: {
    action: values.action,
    payload: JSON.parse(values.payload ?? "{}") as unknown,
  },
  ...(values.params ? { params: JSON.parse(values.params) as JsonObject } : {}),
  seed: values.seed ?? "record",
  commit,
  simulatorVersion: appVersion(),
  ...(values.horizon ? { horizonMs: Number(values.horizon) } : {}),
  ...(values.step ? { stepMs: Number(values.step) } : {}),
});

const json = `${JSON.stringify(recording.scenario, null, 2)}\n`;
if (values.out) writeFileSync(values.out, json);
else process.stdout.write(json);
if (values.diagram) writeFileSync(values.diagram, `${recording.diagram}\n`);
for (const line of recording.skipped) console.error(`not recorded: ${line}`);
process.exit(0);
