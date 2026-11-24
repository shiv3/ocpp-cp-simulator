// apps/cli/src/exportK6/buildBehaviors.ts
// `export-k6 --behavior <file>`: each behavior becomes a built ES module the
// generated script imports; the engine loads it on every charge point exactly
// as the daemon does (`ChargePoint.loadBehavior`).
import * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";
import { behaviorsOfModule } from "@ocpp-cp-simulator/core/cp/application/engine/behaviorModule";
import { DefaultBootNotification } from "@ocpp-cp-simulator/core/cp/domain/types/OcppTypes";
import { createChargePoint } from "@ocpp-cp-simulator/core/cp/infrastructure/charge-point/createChargePoint";
import { createHeadlessServices } from "@ocpp-cp-simulator/core/cp/infrastructure/charge-point/createHeadlessServices";
import { bundleBehavior, typecheckBehavior } from "../behavior/bundleBehavior";

export interface BuiltBehavior {
  readonly file: string;
  /** File name under `behaviors/` in the export. */
  readonly outName: string;
  readonly code: string;
  /** The behavior ids the file declares. */
  readonly ids: readonly string[];
}

export interface BuildBehaviorsResult {
  readonly built: readonly BuiltBehavior[];
  readonly problems: readonly string[];
}

/**
 * Whether a station of the export (OCPP 1.6J) can load `behavior`: the very
 * check `loadBehavior` runs at run time (`requires`, rules, `beforeSend`).
 * Returns the problem, or null.
 */
export function loadProblem(behavior: Behavior): string | null {
  const cp = createChargePoint(
    "export-check",
    DefaultBootNotification,
    1,
    "ws://localhost:1/ocpp",
    null,
    null,
    null,
    {},
    [],
    "OCPP-1.6J",
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    {},
    // No state history: it logs, and nothing here reads it.
    createHeadlessServices(),
  );
  try {
    cp.loadBehavior(behavior);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    cp.dispose();
  }
}

async function buildOne(
  file: string,
  index: number,
): Promise<{ built?: BuiltBehavior; problems: string[] }> {
  const outName = `${String(index + 1).padStart(2, "0")}-${path
    .basename(file)
    .replace(/\.[^.]+$/, "")
    .replace(/\.bundle$/, "")
    .replace(/[^A-Za-z0-9._-]/g, "_")}.bundle.js`;
  if (!fs.existsSync(file)) return { problems: [`No such file: ${file}`] };
  const typeProblems = typecheckBehavior(path.resolve(file));
  if (typeProblems.length > 0) return { problems: typeProblems };
  const bundled = await bundleBehavior(file, { mode: "build" });
  if (!bundled.ok) return { problems: [...bundled.problems] };

  const dir = mkdtempSync(path.join(tmpdir(), "ocpp-export-k6-"));
  try {
    const out = path.join(dir, "behavior.mjs");
    writeFileSync(out, bundled.code);
    let behaviors: Behavior[];
    try {
      const mod: unknown = await import(pathToFileURL(out).href);
      behaviors = behaviorsOfModule(file, mod);
    } catch (error) {
      return {
        problems: [
          `${file}: cannot inspect the bundle to check it loads: ${message(error)}` +
            ` (a behavior that imports k6 modules cannot be checked here)`,
        ],
      };
    }
    const problems = behaviors.flatMap((b) => {
      const problem = loadProblem(b);
      return problem ? [`${file}: behavior "${b.id}": ${problem}`] : [];
    });
    return {
      problems,
      built: {
        file,
        outName,
        code: bundled.code,
        ids: behaviors.map((b) => b.id),
      },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function buildBehaviors(
  files: readonly string[],
): Promise<BuildBehaviorsResult> {
  const built: BuiltBehavior[] = [];
  const problems: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const one = await buildOne(files[i]!, i);
    problems.push(...one.problems);
    if (one.built) built.push(one.built);
  }
  // Two bundles with one id would share one `ctx.state` and one rule set.
  const seen = new Map<string, string>();
  for (const b of built) {
    for (const id of b.ids) {
      const first = seen.get(id);
      if (first !== undefined) {
        problems.push(
          `behavior id "${id}" is declared by ${first} and by ${b.file}`,
        );
      }
      seen.set(id, first ?? b.file);
    }
  }
  return { built, problems };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
