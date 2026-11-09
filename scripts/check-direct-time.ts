// scripts/check-direct-time.ts
//
// Direct reads of the clock and of randomness in packages/core/src/cp/domain
// and packages/core/src/cp/application (docs/concepts/charger-engine.md,
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
  "packages/core/src/cp/infrastructure/transport/v201/transactionMessagesV201.ts",
  "packages/core/src/cp/infrastructure/transport/v201/certificateSigningV201.ts",
  "packages/core/src/cp/infrastructure/transport/v201/transactionEventDeliveryV201.ts",
  "packages/core/src/cp/infrastructure/transport/v201/offlineReplayV201.ts",
  "packages/core/src/cp/infrastructure/transport/v201/eventQueuesV201.ts",
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
  | "setImmediate"
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

/** Names that are one object whatever global object they hang from. */
function globalName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    GLOBAL_OBJECTS.has(expression.expression.text)
  ) {
    return expression.name.text;
  }
  return null;
}

/** `x.name` and `x["name"]`. */
function memberOf(
  node: ts.Node,
): { object: ts.Expression; name: string } | null {
  if (ts.isPropertyAccessExpression(node)) {
    return { object: node.expression, name: node.name.text };
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    return { object: node.expression, name: node.argumentExpression.text };
  }
  return null;
}

/** Is this identifier a value being read, not a name being declared or a type? */
function isValueReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (
    (ts.isPropertyAssignment(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodSignature(p) ||
      ts.isParameter(p) ||
      ts.isVariableDeclaration(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isClassDeclaration(p) ||
      ts.isBindingElement(p) ||
      ts.isEnumMember(p)) &&
    p.name === id
  ) {
    return false;
  }
  if (ts.isBindingElement(p) && p.propertyName === id) return false;
  if (
    ts.isImportSpecifier(p) ||
    ts.isExportSpecifier(p) ||
    ts.isTypeReferenceNode(p) ||
    ts.isTypeQueryNode(p) ||
    ts.isQualifiedName(p) ||
    ts.isExpressionWithTypeArguments(p)
  ) {
    return false;
  }
  return true;
}

/**
 * `Date` used as a value that can reach `Date.now`: not `Date.x`, `new Date(...)`,
 * `x instanceof Date` or a call (those are handled, or are not clock reads).
 */
function isLoneDateReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.expression === id) return false;
  if (ts.isElementAccessExpression(p) && p.expression === id) return false;
  if (ts.isNewExpression(p) || ts.isCallExpression(p)) {
    return p.expression !== id; // an argument: `defer(Date)`
  }
  if (ts.isBinaryExpression(p)) {
    return p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === id;
  }
  return !ts.isTypeOfExpression(p);
}

const OTHER_CLOCK_MEMBERS: ReadonlyArray<[string, string, UseKind]> = [
  ["Date", "now", "Date.now"],
  ["performance", "now", "performance.now"],
  ["Math", "random", "Math.random"],
  ["crypto", "randomUUID", "crypto.randomUUID"],
  ["crypto", "getRandomValues", "crypto.getRandomValues"],
];

/**
 * The direct clock / randomness uses in one source text.
 *
 * Seen, besides the plain calls: the same through `globalThis` / `window` /
 * `self` / `global` (`globalThis.Date.now()`), through `x["now"]`, by
 * reference (`[1].map(Math.random)`, `defer(setTimeout)`, `const t =
 * setTimeout`, `setTimeout.call(...)`), `Date()` called as a function,
 * `const { now } = Date`, `setImmediate`, `process.hrtime`, `Bun.sleep` and
 * `Bun.nanoseconds`, and an import of `randomUUID` / `randomBytes` /
 * `randomInt` from node:crypto or of node:timers/promises. Not seen: an alias
 * that is passed through a function or a property (`const g = globalThis;
 * g.Date.now()`), `eval`, and `new Function`. The check is a guard against the
 * easy slip, not a proof.
 */
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
  const counted = new Set<ts.Node>();

  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      if (
        globalName(node.expression) === "Date" &&
        (node.arguments ?? []).every((a) => ts.isSpreadElement(a))
      ) {
        add(node, "new Date()");
        counted.add(node.expression);
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (globalName(callee) === "Date") {
        add(node, "new Date()"); // `Date()` is the current time as a string
        counted.add(callee);
      }
    }
    const member = memberOf(node);
    if (member) {
      const object = globalName(member.object);
      if (object !== null) {
        const hit = OTHER_CLOCK_MEMBERS.find(
          ([o, n]) => o === object && n === member.name,
        );
        if (hit) {
          add(node, hit[2]);
          counted.add(member.object);
        } else if (object === "process" && member.name === "hrtime") {
          add(node, "performance.now");
        } else if (
          object === "Bun" &&
          (member.name === "sleep" || member.name === "nanoseconds")
        ) {
          add(node, "performance.now");
        }
      }
      // `window.setTimeout(...)`, `globalThis["setTimeout"](...)`.
      if (
        ts.isIdentifier(member.object) &&
        GLOBAL_OBJECTS.has(member.object.text) &&
        GLOBAL_TIMERS.has(member.name)
      ) {
        add(node, member.name as UseKind);
      }
    } else if (ts.isIdentifier(node) && isValueReference(node)) {
      if (GLOBAL_TIMERS.has(node.text)) {
        add(node, node.text as UseKind);
      } else if (node.text === "setImmediate") {
        add(node, "setImmediate");
      } else if (
        node.text === "Date" &&
        !counted.has(node) &&
        isLoneDateReference(node)
      ) {
        // `const d = Date; d.now()`, `const { now } = Date`, `use(Date)`
        add(node, "Date.now");
      } else if (
        (node.text === "Math" || node.text === "performance") &&
        ts.isCallExpression(node.parent) &&
        node.parent.arguments.includes(node)
      ) {
        add(node, node.text === "Math" ? "Math.random" : "performance.now");
      }
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const from = node.moduleSpecifier.text.replace(/^node:/, "");
      if (from === "timers/promises") add(node, "setTimeout");
      if (from === "crypto") {
        const named = node.importClause?.namedBindings;
        if (named && ts.isNamedImports(named)) {
          for (const el of named.elements) {
            const name = (el.propertyName ?? el.name).text;
            if (name === "randomUUID") add(el, "crypto.randomUUID");
            else if (name === "randomBytes" || name === "randomInt") {
              add(el, "crypto.getRandomValues");
            } else if (name === "getRandomValues") {
              add(el, "crypto.getRandomValues");
            }
          }
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
    file: "packages/core/src/cp/application/scenario/ScenarioRepository.ts",
    kind: "new Date()",
    count: 1,
    reason: "updatedAt default of a stored scenario",
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
    "\nUse the injected clock (this.clock / ctx) and random streams instead; see docs/concepts/charger-engine.md.",
  );
  return 1;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
