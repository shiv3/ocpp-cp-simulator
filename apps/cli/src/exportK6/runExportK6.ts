// apps/cli/src/exportK6/runExportK6.ts
// `export-k6`: a k6 load test that runs the simulator's own charge point and
// scenario engine (packages/core, bundled by packages/k6-host) for every
// virtual charge point. The export is `engine.js` (the bundle), `script.js`
// (k6 options, metrics, wiring), `scenario.json` and the built behaviors.
// OCPP 1.6J only.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { validateScenarioSchema } from "@ocpp-cp-simulator/core/scenario/scenarioSchemaValidator";
import { buildBehaviors } from "./buildBehaviors";
import { renderIdsExample, renderReadme, renderScript } from "./emit/render";
import { loadEngineBundle } from "./engineBundle";
import type { ExportK6Args } from "./parseExportK6Args";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Connectors a charge point of the export needs: the highest id the scenario names. */
export function connectorsNeeded(
  scenario: ScenarioDefinition | undefined,
): number {
  let max = 1;
  if (!scenario) return max;
  if (typeof scenario.targetId === "number") max = scenario.targetId;
  for (const node of scenario.nodes) {
    const data: unknown = node.data;
    if (isPlainObject(data) && typeof data.connectorId === "number") {
      max = Math.max(max, data.connectorId);
    }
  }
  return Math.max(1, Math.min(max, 64));
}

export async function runExportK6(args: ExportK6Args): Promise<number> {
  let scenario: ScenarioDefinition | undefined;
  let scenarioRaw: unknown;
  if (args.scenarioFile !== "") {
    let raw: string;
    try {
      raw = fs.readFileSync(args.scenarioFile, "utf8");
    } catch (err) {
      return fail(`cannot read scenario file: ${message(err)}`);
    }
    try {
      scenarioRaw = JSON.parse(raw);
    } catch (err) {
      return fail(`scenario file is not valid JSON: ${message(err)}`);
    }
    // The schema check never throws and reports `valid: false` for a
    // non-object value (most importantly `null`).
    const schema = validateScenarioSchema(scenarioRaw);
    if (!schema.valid) {
      return fail(
        `scenario does not match packages/core/schema/scenario.schema.json:\n  ${schema.errors
          .slice(0, 5)
          .join("\n  ")}`,
      );
    }
    scenario = scenarioRaw as ScenarioDefinition;
    if (!scenario.nodes.some((n) => n.type === "start")) {
      return fail("scenario cannot be exported:\n  scenario has no start node");
    }
  }

  const behaviors = await buildBehaviors(args.behaviorFiles ?? []);
  if (behaviors.problems.length > 0) {
    return fail(
      `behavior cannot be exported:\n  ${behaviors.problems.join("\n  ")}`,
    );
  }

  const outDir = args.outDir;
  if (fs.existsSync(outDir)) {
    if (!fs.statSync(outDir).isDirectory()) {
      return fail(`${outDir} exists and is not a directory`);
    }
    if (fs.readdirSync(outDir).length > 0 && !args.force) {
      return fail(
        `output directory ${outDir} is not empty (use --force to overwrite)`,
      );
    }
  }

  let engine: string;
  try {
    engine = await loadEngineBundle();
  } catch (err) {
    return fail(message(err));
  }

  const behaviorFiles = behaviors.built.map((b) => b.outName);
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "engine.js"), engine);
    if (scenario) {
      fs.writeFileSync(
        path.join(outDir, "scenario.json"),
        `${JSON.stringify(scenario, null, 2)}\n`,
      );
    }
    if (behaviors.built.length > 0) {
      fs.mkdirSync(path.join(outDir, "behaviors"), { recursive: true });
      for (const b of behaviors.built) {
        fs.writeFileSync(path.join(outDir, "behaviors", b.outName), b.code);
      }
    }
    fs.writeFileSync(
      path.join(outDir, "script.js"),
      renderScript({
        ...(scenario ? { scenario } : {}),
        behaviorFiles,
        connectors: connectorsNeeded(scenario),
        chargersPerVu: args.chargersPerVu,
        ocppVersion: args.ocppVersion,
      }),
    );
    fs.writeFileSync(
      path.join(outDir, "README.md"),
      renderReadme({
        title: scenario ? (scenario.name ?? scenario.id) : "behaviors",
        hasScenario: scenario !== undefined,
        behaviorFiles,
        chargersPerVu: args.chargersPerVu,
      }),
    );
    fs.writeFileSync(path.join(outDir, "ids.example.json"), renderIdsExample());
  } catch (err) {
    return fail(`cannot write bundle: ${message(err)}`);
  }

  process.stdout.write(
    `Wrote k6 load test to ${outDir}\nRun it with: CSMS_URL=ws://... CHARGERS=100 k6 run ${path.join(outDir, "script.js")}\n`,
  );
  return 0;
}

function fail(msg: string): number {
  process.stderr.write(`Error: ${msg}\n`);
  return 1;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
