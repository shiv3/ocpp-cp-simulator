import { readFileSync } from "node:fs";
import type { JsonObject } from "@ocpp-cp-sim/contracts/behavior";
import { jsonProblem } from "@ocpp-cp-sim/core/cp/application/behavior/paramsSchema";

/**
 * `--behavior-params <id>=<json file or inline json>` (repeatable): the params
 * a behavior gets on the charge points this process bootstraps. A value that
 * starts with `{` is JSON; anything else is the path of a JSON file. Data
 * only: nothing here is ever evaluated, and the engine checks the object
 * against the behavior's params schema (refused, never coerced).
 */
export function parseBehaviorParamsFlag(
  spec: string,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): { id: string; params: JsonObject } {
  const eq = spec.indexOf("=");
  if (eq <= 0 || eq === spec.length - 1) {
    throw new Error(
      `--behavior-params expects <id>=<json file or inline json>, got ${JSON.stringify(spec)}`,
    );
  }
  const id = spec.slice(0, eq);
  const value = spec.slice(eq + 1);
  let text = value;
  if (!value.trimStart().startsWith("{")) {
    try {
      text = readFile(value);
    } catch (error) {
      throw new Error(
        `--behavior-params ${id}: cannot read ${JSON.stringify(value)}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `--behavior-params ${id}: not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`--behavior-params ${id}: the value must be a JSON object`);
  }
  const problem = jsonProblem(parsed);
  if (problem) throw new Error(`--behavior-params ${id}: ${problem}`);
  return { id, params: parsed as JsonObject };
}

/** Fold the repeated flag into the map; a second entry for an id is an error. */
export function collectBehaviorParams(
  specs: readonly string[],
  readFile?: (path: string) => string,
): Record<string, JsonObject> {
  const out: Record<string, JsonObject> = {};
  for (const spec of specs) {
    const { id, params } = parseBehaviorParamsFlag(spec, readFile);
    if (Object.hasOwn(out, id)) {
      throw new Error(`--behavior-params ${id} is given twice`);
    }
    out[id] = params;
  }
  return out;
}
