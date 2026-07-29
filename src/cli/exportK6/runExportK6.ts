// src/cli/exportK6/runExportK6.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { validateScenarioSchema } from "../../scenario/scenarioSchemaValidator";
import { SUPPORTED_ASSERTION_TYPES } from "./runtime/assertions";
import type { ScenarioJson, ScenarioNodeJson } from "./runtime/types";
import { RUNTIME_FILES } from "./runtimeManifest";
import {
  renderEntryScript,
  renderIdsExample,
  renderReadme,
} from "./emit/render";
import type { ExportK6Args } from "./parseExportK6Args";

const SUPPORTED_NODE_TYPES = new Set([
  "start",
  "end",
  "statusChange",
  "transaction",
  "meterValue",
  "delay",
  "notification",
  "connectorPlug",
  "remoteStartTrigger",
  "remoteStopTrigger",
  "statusTrigger",
  "reserveNow",
  "cancelReservation",
  "reservationTrigger",
  "statusNotification",
  "unlockOutcome",
  "configSet",
  "dataTransfer",
  "csmsCallTrigger",
  "responseOverride",
]);

export async function runExportK6(args: ExportK6Args): Promise<number> {
  let raw: string;
  try {
    raw = fs.readFileSync(args.scenarioFile, "utf8");
  } catch (err) {
    return fail(`cannot read scenario file: ${message(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return fail(`scenario file is not valid JSON: ${message(err)}`);
  }

  // A non-object JSON value (most importantly `null`, since `typeof null
  // === "object"`) has no `.nodes` to look at — go straight to the
  // schema check, which is documented to never throw and to report
  // `valid: false` for exactly this case, instead of letting
  // validateExportability's property access below throw a TypeError.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const schema = validateScenarioSchema(parsed);
    return fail(
      `scenario does not match schema/scenario.schema.json:\n  ${schema.errors
        .slice(0, 5)
        .join("\n  ")}`,
    );
  }

  // Exportability checks (unsupported node/assertion types, missing start
  // node) run before the JSON-schema check: the schema's node/assertion
  // `type` enums are a superset of what this exporter actually supports
  // (e.g. inboundPolicy/certQuirks nodes are schema-valid but Phase 1
  // export doesn't implement them), and Ajv's enum-mismatch message never
  // repeats the offending value — only this exporter-specific check can
  // name it. Both checks are defensive about shape since neither has run
  // yet at this point.
  const scenario = parsed as ScenarioJson;
  const problems = validateExportability(scenario);
  if (problems.length > 0) {
    return fail(`scenario cannot be exported:\n  ${problems.join("\n  ")}`);
  }

  const schema = validateScenarioSchema(parsed);
  if (!schema.valid) {
    return fail(
      `scenario does not match schema/scenario.schema.json:\n  ${schema.errors
        .slice(0, 5)
        .join("\n  ")}`,
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

  const runtimeSrc = path.dirname(
    fileURLToPath(new URL("./runtime/index.ts", import.meta.url)),
  );
  try {
    fs.mkdirSync(path.join(outDir, "ocpp-runtime", "wire"), {
      recursive: true,
    });
    for (const file of RUNTIME_FILES) {
      fs.copyFileSync(
        path.join(runtimeSrc, file),
        path.join(outDir, "ocpp-runtime", file),
      );
    }
    fs.writeFileSync(
      path.join(outDir, "scenario.json"),
      `${JSON.stringify(scenario, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(outDir, "scenario.k6.ts"),
      renderEntryScript(scenario, { ocppVersion: args.ocppVersion }),
    );
    fs.writeFileSync(
      path.join(outDir, "README.md"),
      renderReadme({
        scenarioName: scenario.name ?? scenario.id,
        ocppVersion: args.ocppVersion,
      }),
    );
    fs.writeFileSync(path.join(outDir, "ids.example.json"), renderIdsExample());
  } catch (err) {
    return fail(`cannot write bundle: ${message(err)}`);
  }

  process.stdout.write(
    `Wrote k6 load test to ${outDir}\nRun it with: CSMS_URL=wss://... k6 run ${path.join(outDir, "scenario.k6.ts")}\n`,
  );
  return 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateExportability(scenario: ScenarioJson): string[] {
  const problems: string[] = [];
  // Runs before schema validation (see call site), so `scenario.nodes` /
  // `scenario.assertions` are not yet guaranteed to be arrays, and each of
  // their elements is not yet guaranteed to be an object, at this point.
  const rawNodes: unknown[] = Array.isArray(scenario.nodes)
    ? scenario.nodes
    : [];
  const nodes: ScenarioNodeJson[] = [];
  rawNodes.forEach((n, i) => {
    if (!isPlainObject(n)) {
      problems.push(`node at index ${i} is not an object`);
      return;
    }
    nodes.push(n as unknown as ScenarioNodeJson);
  });
  if (!nodes.some((n) => n.type === "start")) {
    problems.push("scenario has no start node");
  }
  for (const node of nodes) {
    if (!SUPPORTED_NODE_TYPES.has(node.type)) {
      problems.push(`unsupported node type "${node.type}" (node ${node.id})`);
    }
  }
  const rawAssertions: unknown[] = Array.isArray(scenario.assertions)
    ? scenario.assertions
    : [];
  rawAssertions.forEach((spec, i) => {
    if (!isPlainObject(spec)) {
      problems.push(`assertion at index ${i} is not an object`);
      return;
    }
    if (!SUPPORTED_ASSERTION_TYPES.has(spec.type as string)) {
      problems.push(
        `unsupported assertion type "${spec.type}" (assertion ${spec.id})`,
      );
    }
  });
  return problems;
}

function fail(msg: string): number {
  process.stderr.write(`Error: ${msg}\n`);
  return 1;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
