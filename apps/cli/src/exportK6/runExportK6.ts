// apps/cli/src/exportK6/runExportK6.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { validateScenarioSchema } from "@ocpp-cp-simulator/core/scenario/scenarioSchemaValidator";
import { SUPPORTED_ASSERTION_TYPES } from "@ocpp-cp-simulator/k6-runtime/assertions";
import type {
  ScenarioJson,
  ScenarioNodeJson,
} from "@ocpp-cp-simulator/k6-runtime/types";
import { RUNTIME_FILES } from "./runtimeManifest";
import { RUNTIME_SOURCES } from "./runtimeSources";
import {
  renderEntryScript,
  renderIdsExample,
  renderReadme,
} from "./emit/render";
import type { ExportK6Args } from "./parseExportK6Args";
import { runExportK6Behavior } from "./runExportK6Behavior";

/** Scenario node types this exporter walks. Anything else is refused by name
 *  rather than exported and silently skipped. Exported because
 *  `__tests__/documentedSubset.test.ts` holds it against
 *  `packages/core/schema/scenario.schema.json` and the table in
 *  `docs/entities/cli.md#export-k6` (#329). */
export const SUPPORTED_NODE_TYPES = new Set([
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
  "ocppCall",
]);

export async function runExportK6(args: ExportK6Args): Promise<number> {
  if ((args.behaviorFiles ?? []).length > 0) return runExportK6Behavior(args);
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
      `scenario does not match packages/core/schema/scenario.schema.json:\n  ${schema.errors
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
      `scenario does not match packages/core/schema/scenario.schema.json:\n  ${schema.errors
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

  try {
    // The runtime is embedded (runtimeSources.ts, generated from runtime/)
    // rather than copied from beside this module: the published CLI is a
    // single-file bundle and the desktop sidecar a compiled binary, and
    // neither has the runtime's .ts files on disk.
    for (const file of RUNTIME_FILES) {
      const target = path.join(outDir, "ocpp-runtime", file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, RUNTIME_SOURCES[file]);
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
      problems.push(
        `unsupported node type "${node.type}" (node ${node.id})${
          REFUSED_BEHAVIOR_NODES[node.type] ?? ""
        }`,
      );
      continue;
    }
    // Schema 1.5 (#566): a CALL the scenario takes over, and a payload that
    // reads from it, need a station behavior engine the k6 runtime does not
    // have. Refused, never exported as the observing node they resemble.
    const data = isPlainObject(node.data) ? node.data : {};
    if (node.type === "csmsCallTrigger") {
      if (data.behavior === "replace") {
        problems.push(
          `csmsCallTrigger behavior "replace" is not supported by export-k6 (node ${node.id}): the k6 runtime always lets the station answer the CALL; use "observe" or run the scenario on the simulator`,
        );
      } else if (data.onBusy !== undefined) {
        problems.push(
          `csmsCallTrigger onBusy is only meaningful with behavior "replace", which export-k6 does not support (node ${node.id})`,
        );
      }
    }
    // Schema 1.6 (#654): a wait the k6 interpreter has no seeded stream or
    // station clock for.
    if (
      node.type === "delay" &&
      (data.until !== undefined || data.jitterSeconds !== undefined)
    ) {
      problems.push(
        `delay "until" and "jitterSeconds" (schema 1.6) are not supported by export-k6 (node ${node.id}): the k6 runtime waits for delaySeconds only`,
      );
    }
    if (node.type === "ocppCall" && containsFrom(data.payload)) {
      problems.push(
        `ocppCall payload uses "$from", which needs a CALL taken over by a csmsCallTrigger with behavior "replace"; export-k6 does not support it (node ${node.id})`,
      );
    }
  }
  // Schema 1.8 / 1.10: the k6 interpreter walks ordinary edges only and fails on a
  // timeout; it has no loop bounds either. Either kind would be silently taken
  // as a next step.
  const rawEdges: unknown[] = Array.isArray(scenario.edges)
    ? scenario.edges
    : [];
  for (const edge of rawEdges) {
    if (isPlainObject(edge) && edge.kind === "timeout") {
      problems.push(
        `timeout edges (schema 1.8) are not supported by export-k6 (edge ${String(edge.id)} from ${String(edge.source)}): the k6 runtime fails the iteration when a wait times out; remove the edge or run the scenario on the simulator`,
      );
    }
    if (isPlainObject(edge) && edge.kind === "loop") {
      problems.push(
        `loop edges (schema 1.10) are not supported by export-k6 (edge ${String(edge.id)} from ${String(edge.source)}): the k6 runtime has no loop bounds (times, forSeconds, until); run the scenario on the simulator`,
      );
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

/** Why a 1.5 node type is not exported, appended to the generic message. */
const REFUSED_BEHAVIOR_NODES: Readonly<Record<string, string>> = {
  callResponse:
    ": answering a CALL the scenario took over needs a station behavior engine, which the k6 runtime does not have",
  notify:
    ": sending a status notification from a scenario (schema 1.6) goes through the station engine, which the k6 runtime does not have",
  switch:
    ": branching on a value (schema 1.6) needs the $from roots of a station, which the k6 runtime does not have",
  choice:
    ": a seeded choice (schema 1.6) needs the station's seeded streams, which the k6 runtime does not have",
  setState:
    ": the state of a run (schema 1.6) is read through $from, which the k6 runtime does not have",
  parallel:
    ": forking a branch and meeting it at a join (schema 1.9) needs branch-scoped cancellation, which the k6 interpreter (one walk per virtual user) does not have",
  join: ": a join (schema 1.9) meets the branches of a parallel, which export-k6 does not support",
  useBehavior:
    ': selecting a behavior, setting its params (schema 1.6) or disabling it (mode "disable") needs a station behavior engine, which the k6 runtime does not have; a k6 behavior runs with its declared defaults',
};

/** Does `value` hold a `{ "$from": … }` reference anywhere? */
function containsFrom(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsFrom);
  if (isPlainObject(value)) {
    return "$from" in value || Object.values(value).some(containsFrom);
  }
  return false;
}

function fail(msg: string): number {
  process.stderr.write(`Error: ${msg}\n`);
  return 1;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
