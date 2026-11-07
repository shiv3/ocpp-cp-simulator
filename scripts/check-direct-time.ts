// scripts/check-direct-time.ts
//
// Direct reads of the clock and of randomness in packages/core/src/cp/domain
// and packages/core/src/cp/application (docs/analyses/charger-engine.md,
// "Clock and random"). Everything there reads time and arms timers through the
// injected SimClock and draws random numbers from the injected RngStreams, so
// a run can be replayed. This check lists what is left and fails when
//
//   * a file reads one directly that EXEMPTIONS does not allow, or
//   * an exemption allows more than the file still has (the list only shrinks:
//     delete or lower the entry when you remove a use).
//
//   bun run scripts/check-direct-time.ts          # exit 1 on any violation
//   bun run scripts/check-direct-time.ts --list   # every use found
//
// What counts: `Date.now()`, `new Date()` with no argument (a default
// parameter included), `performance.now()`, `Math.random()`,
// `crypto.randomUUID()`, `crypto.getRandomValues()`, and the global
// `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval` (called bare or
// through `globalThis` / `window` / `self`). `this.clock.setTimeout(...)` and
// `new Date(value)` are not direct reads. Tests (`__tests__/`, `*.test.ts`)
// are not scanned.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");

/** Directories scanned, repo-relative. */
export const SCANNED_DIRS = [
  "packages/core/src/cp/domain",
  "packages/core/src/cp/application",
] as const;

/**
 * Single files scanned as well: the two JSON message handlers and the helpers
 * that arm their timers. The rest of `infrastructure/transport` (the
 * WebSocket with its reconnect and ping timers, the SOAP handler) still runs
 * on the platform clock; see "What virtual time covers" in the design.
 */
export const SCANNED_FILES = [
  "packages/core/src/cp/infrastructure/transport/OCPPMessageHandler.ts",
  "packages/core/src/cp/infrastructure/transport/OCPPMessageHandlerV201.ts",
  "packages/core/src/cp/infrastructure/transport/CallWaiters.ts",
  "packages/core/src/cp/infrastructure/transport/ExpertCalls.ts",
  "packages/core/src/cp/infrastructure/transport/RawFrameSender.ts",
] as const;

export type UseKind =
  | "Date.now"
  | "new Date()"
  | "performance.now"
  | "Math.random"
  | "crypto.randomUUID"
  | "crypto.getRandomValues"
  | "setTimeout"
  | "setInterval"
  | "clearTimeout"
  | "clearInterval";

export interface Use {
  readonly kind: UseKind;
  readonly line: number;
}

export interface Exemption {
  /** Repo-relative file. */
  readonly file: string;
  readonly kind: UseKind;
  /** How many uses of `kind` the file may still have. */
  readonly count: number;
  /** Why it may stay on the platform. */
  readonly reason: string;
}

const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self", "global"]);
const GLOBAL_TIMERS = new Set([
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
]);

/** The direct clock / randomness uses in one source text. */
export function scanSource(fileName: string, text: string): Use[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const uses: Use[] = [];
  const add = (node: ts.Node, kind: UseKind) =>
    uses.push({
      kind,
      line:
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });

  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Date" &&
        (node.arguments?.length ?? 0) === 0
      ) {
        add(node, "new Date()");
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && GLOBAL_TIMERS.has(callee.text)) {
        add(node, callee.text as UseKind);
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression)
      ) {
        const object = callee.expression.text;
        const name = callee.name.text;
        if (object === "Date" && name === "now") add(node, "Date.now");
        else if (object === "performance" && name === "now") {
          add(node, "performance.now");
        } else if (object === "Math" && name === "random") {
          add(node, "Math.random");
        } else if (object === "crypto" && name === "randomUUID") {
          add(node, "crypto.randomUUID");
        } else if (object === "crypto" && name === "getRandomValues") {
          add(node, "crypto.getRandomValues");
        } else if (GLOBAL_OBJECTS.has(object) && GLOBAL_TIMERS.has(name)) {
          add(node, name as UseKind);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return uses;
}

/**
 * The uses that stay on the platform, and why. Nothing here may grow; when a
 * use is migrated, lower or delete its entry (the check fails on a stale one).
 */
export const EXEMPTIONS: readonly Exemption[] = [
  // Storage bookkeeping: the wall-clock moment a row was written. Not charger
  // behaviour, never on the wire, and the repositories are built outside a
  // charge point.
  {
    file: "packages/core/src/cp/domain/persistence/BlueprintRepository.ts",
    kind: "new Date()",
    count: 1,
    reason: "updated_at of a stored blueprint row",
  },
  {
    file: "packages/core/src/cp/domain/persistence/ScenarioRepository.ts",
    kind: "new Date()",
    count: 1,
    reason: "updatedAt default of a stored scenario",
  },
  {
    file: "packages/core/src/cp/domain/persistence/SqliteScenarioRepository.ts",
    kind: "new Date()",
    count: 1,
    reason: "updatedAt default of a stored scenario",
  },
  {
    file: "packages/core/src/cp/domain/persistence/SqliteConnectorRuntimeRepository.ts",
    kind: "new Date()",
    count: 1,
    reason: "saved_at of a stored connector snapshot",
  },
  {
    file: "packages/core/src/cp/domain/persistence/EngineStateRepository.ts",
    kind: "new Date()",
    count: 1,
    reason: "updated_at stamp of the stored engine state row",
  },
  // Pure helpers whose `now` parameter defaults to the platform clock. Every
  // production caller (Connector, ChargePoint) passes the injected clock's
  // instant; the default serves callers with no clock.
  {
    file: "packages/core/src/cp/domain/charge-point/ChargingProfileStore.ts",
    kind: "new Date()",
    count: 1,
    reason: "default of getActive(now); production callers pass the clock",
  },
  {
    file: "packages/core/src/cp/domain/connector/ChargingScheduleResolver.ts",
    kind: "new Date()",
    count: 3,
    reason:
      "default of now in the resolvers; production callers pass the clock",
  },
  // Log persistence batches writes on a real timer; it is I/O pacing.
  {
    file: "packages/core/src/cp/domain/persistence/LogRepository.ts",
    kind: "setTimeout",
    count: 1,
    reason: "flush pacing of the log table, I/O batching",
  },
  {
    file: "packages/core/src/cp/domain/persistence/LogRepository.ts",
    kind: "clearTimeout",
    count: 1,
    reason: "flush pacing of the log table, I/O batching",
  },
];

export interface Finding {
  readonly file: string;
  readonly kind: UseKind;
  readonly lines: readonly number[];
  readonly allowed: number;
}

export interface Report {
  /** Uses beyond what the exemptions allow. */
  readonly violations: Finding[];
  /** Exemptions that allow more than the file still has. */
  readonly stale: Array<{ exemption: Exemption; found: number }>;
}

/** Compare the uses found per file with the exemptions. */
export function evaluate(
  usesByFile: ReadonlyMap<string, readonly Use[]>,
  exemptions: readonly Exemption[] = EXEMPTIONS,
): Report {
  const allowed = new Map<string, number>();
  for (const e of exemptions) {
    const key = `${e.file}\u0000${e.kind}`;
    allowed.set(key, (allowed.get(key) ?? 0) + e.count);
  }
  const violations: Finding[] = [];
  const seen = new Map<string, number>();
  for (const [file, uses] of usesByFile) {
    const byKind = new Map<UseKind, number[]>();
    for (const use of uses) {
      const lines = byKind.get(use.kind) ?? [];
      lines.push(use.line);
      byKind.set(use.kind, lines);
    }
    for (const [kind, lines] of byKind) {
      const key = `${file}\u0000${kind}`;
      seen.set(key, lines.length);
      const limit = allowed.get(key) ?? 0;
      if (lines.length > limit) {
        violations.push({ file, kind, lines, allowed: limit });
      }
    }
  }
  const stale: Report["stale"] = [];
  for (const e of exemptions) {
    const found = seen.get(`${e.file}\u0000${e.kind}`) ?? 0;
    const total = allowed.get(`${e.file}\u0000${e.kind}`) ?? 0;
    if (found < total) stale.push({ exemption: e, found });
  }
  return { violations, stale };
}

function isTestFile(path: string): boolean {
  return (
    path.includes(`${sep}__tests__${sep}`) ||
    /\.(bun\.)?test\.tsx?$/.test(path) ||
    path.endsWith(".d.ts")
  );
}

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listSources(full));
    else if (/\.tsx?$/.test(name) && !isTestFile(full)) out.push(full);
  }
  return out.sort();
}

export function scanTree(root: string = REPO_ROOT): Map<string, Use[]> {
  const result = new Map<string, Use[]>();
  for (const dir of SCANNED_DIRS) {
    for (const file of listSources(join(root, dir))) {
      const rel = relative(root, file).split(sep).join("/");
      const uses = scanSource(rel, readFileSync(file, "utf8"));
      if (uses.length > 0) result.set(rel, uses);
    }
  }
  for (const rel of SCANNED_FILES) {
    const uses = scanSource(rel, readFileSync(join(root, rel), "utf8"));
    if (uses.length > 0) result.set(rel, uses);
  }
  return result;
}

export function formatReport(report: Report): string {
  const lines: string[] = [];
  for (const v of report.violations) {
    lines.push(
      `${v.file}: ${v.lines.length} direct ${v.kind} (allowed ${v.allowed}) at line ${v.lines.join(", ")}`,
    );
  }
  for (const s of report.stale) {
    lines.push(
      `${s.exemption.file}: exemption for ${s.exemption.kind} allows ${s.exemption.count} but ${s.found} remain; lower or delete it in scripts/check-direct-time.ts`,
    );
  }
  return lines.join("\n");
}

function main(argv: string[]): number {
  const found = scanTree();
  if (argv.includes("--list")) {
    for (const [file, uses] of found) {
      for (const use of uses) console.log(`${file}:${use.line} ${use.kind}`);
    }
    return 0;
  }
  const report = evaluate(found);
  if (report.violations.length === 0 && report.stale.length === 0) {
    let total = 0;
    for (const uses of found.values()) total += uses.length;
    console.log(
      `direct time/randomness OK: ${SCANNED_DIRS.length} directories and ${SCANNED_FILES.length} files scanned, ${total} exempted use(s)`,
    );
    return 0;
  }
  console.error(formatReport(report));
  console.error(
    "\nUse the injected clock (this.clock / ctx) and random streams instead; see docs/analyses/charger-engine.md.",
  );
  return 1;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
