// apps/cli/src/exportK6/runExportK6Behavior.ts
// `export-k6 --behavior <file>`: a k6 load test whose virtual charge points run
// built behavior bundles (docs/analyses/charger-engine.md, "Loading code").
// The bundle is imported statically by the generated entry script; nothing is
// loaded by name at run time. OCPP 1.6J only.
import * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Behavior } from "@ocpp-cp-sim/contracts/behavior";
import {
  UNSUPPORTED_CTX_MEMBERS,
  unmetBy,
} from "@ocpp-cp-sim/k6-runtime/behaviorHost";
import ts from "typescript";
import { cannedResponses16 } from "@ocpp-cp-sim/core/cp/application/engine/responseValidation";
import { behaviorsOfModule } from "@ocpp-cp-sim/core/cp/application/engine/behaviorModule";
import { bundleBehavior, typecheckBehavior } from "../behavior/bundleBehavior";
import {
  renderBehaviorEntry,
  renderBehaviorReadme,
  renderIdsExample,
} from "./emit/render";
import { RUNTIME_FILES } from "./runtimeManifest";
import { RUNTIME_SOURCES } from "./runtimeSources";
import type { ExportK6Args } from "./parseExportK6Args";

/**
 * Names of unsupported `ctx` members the code mentions: `x.name`,
 * `x["name"]`, or a destructured `{ name }`. Syntactic, so it also flags an
 * unrelated property of the same name; the error says so.
 */
export function unsupportedCtxUses(code: string): string[] {
  const source = ts.createSourceFile(
    "bundle.js",
    code,
    ts.ScriptTarget.ES2017,
    true,
  );
  const found = new Set<string>();
  const check = (name: string): void => {
    if (UNSUPPORTED_CTX_MEMBERS.includes(name)) found.add(name);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) check(node.name.text);
    else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      check(node.argumentExpression.text);
    } else if (
      ts.isBindingElement(node) &&
      ts.isObjectBindingPattern(node.parent)
    ) {
      // Only an object pattern names a property: `const [connector] = pair`
      // names a variable.
      const key = node.propertyName ?? node.name;
      if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) check(key.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found].sort();
}

interface Built {
  readonly file: string;
  readonly outName: string;
  readonly code: string;
  readonly problems: string[];
  /** The behavior ids the file declares; empty when it could not be inspected. */
  readonly ids?: readonly string[];
}

async function buildOne(file: string, index: number): Promise<Built> {
  const problems: string[] = [];
  const outName = `${String(index + 1).padStart(2, "0")}-${path
    .basename(file)
    .replace(/\.[^.]+$/, "")
    .replace(/\.bundle$/, "")
    .replace(/[^A-Za-z0-9._-]/g, "_")}.bundle.js`;
  if (!fs.existsSync(file)) {
    return { file, outName, code: "", problems: [`No such file: ${file}`] };
  }
  const typeProblems = typecheckBehavior(path.resolve(file));
  if (typeProblems.length > 0) {
    return { file, outName, code: "", problems: typeProblems };
  }
  const bundled = await bundleBehavior(file, { mode: "build" });
  if (!bundled.ok) {
    return { file, outName, code: "", problems: [...bundled.problems] };
  }
  const uses = unsupportedCtxUses(bundled.code);
  for (const name of uses) {
    problems.push(
      `${file}: uses ctx.${name} (or a property of that name), which the k6 host does not support`,
    );
  }
  // What `requires` and the rules say needs the loaded module.
  let ids: string[] | undefined;
  const dir = mkdtempSync(path.join(tmpdir(), "ocpp-export-k6-"));
  try {
    const out = path.join(dir, "behavior.mjs");
    writeFileSync(out, bundled.code);
    let behaviors: Behavior[];
    try {
      const mod: unknown = await import(pathToFileURL(out).href);
      behaviors = behaviorsOfModule(file, mod);
    } catch (error) {
      problems.push(
        `${file}: cannot inspect the bundle to check what it requires: ${message(error)}` +
          ` (a behavior that imports k6 modules cannot be checked here)`,
      );
      return { file, outName, code: bundled.code, problems };
    }
    for (const b of behaviors) problems.push(...unmetBy(b));
    ids = behaviors.map((b) => b.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { file, outName, code: bundled.code, problems, ids };
}

export async function runExportK6Behavior(args: ExportK6Args): Promise<number> {
  const files = args.behaviorFiles ?? [];
  const built: Built[] = [];
  for (let i = 0; i < files.length; i++)
    built.push(await buildOne(files[i], i));
  const problems = built.flatMap((b) => b.problems);
  // Two bundles with one id would share one `ctx.state` and one rule set.
  const seen = new Map<string, string>();
  for (const b of built) {
    for (const id of b.ids ?? []) {
      const first = seen.get(id);
      if (first !== undefined) {
        problems.push(
          `behavior id "${id}" is declared by ${first} and by ${b.file}`,
        );
      }
      seen.set(id, first ?? b.file);
    }
  }
  if (problems.length > 0) {
    return fail(`behavior cannot be exported:\n  ${problems.join("\n  ")}`);
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
    for (const file of RUNTIME_FILES) {
      const target = path.join(outDir, "ocpp-runtime", file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, RUNTIME_SOURCES[file]);
    }
    fs.mkdirSync(path.join(outDir, "behaviors"), { recursive: true });
    for (const b of built) {
      fs.writeFileSync(path.join(outDir, "behaviors", b.outName), b.code);
    }
    const names = built.map((b) => b.outName);
    fs.writeFileSync(
      path.join(outDir, "behavior.k6.ts"),
      renderBehaviorEntry(names, {
        ocppVersion: args.ocppVersion,
        canned: cannedResponses16(),
      }),
    );
    fs.writeFileSync(
      path.join(outDir, "README.md"),
      renderBehaviorReadme({ bundles: names, ocppVersion: args.ocppVersion }),
    );
    fs.writeFileSync(path.join(outDir, "ids.example.json"), renderIdsExample());
  } catch (err) {
    return fail(`cannot write bundle: ${message(err)}`);
  }
  process.stdout.write(
    `Wrote k6 load test to ${outDir}\nRun it with: CSMS_URL=wss://... k6 run ${path.join(outDir, "behavior.k6.ts")}\n`,
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
