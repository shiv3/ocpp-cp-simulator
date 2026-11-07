// scripts/check-single-writer.ts
//
// One writer for connector state (docs/analyses/charger-engine.md, "Charger
// engine"). The status, availability, scheduled availability and error fields
// of a connector are a record in the charger engine's state, and the engine
// is the only code that changes it. `Connector` keeps its setters so that
// callers need not change, but they only dispatch an engine event, and only
// code under `application/engine/` may use them. Everything else asks the
// charge point (`updateConnectorStatus`) or dispatches an event itself.
//
// This check fails when non-test code outside `application/engine/` assigns
// one of those properties on a connector. It is syntactic: an assignment
// (`=`, `+=`, ..., `++`) to `<receiver>.<field>` counts when the receiver's
// text mentions "connector" (`connector`, `this.connector`,
// `cp.getConnector(1)!`, `connectors.get(id)!`). A receiver under another name
// is not seen; keep the name when you pass a connector around.
//
//   bun run scripts/check-single-writer.ts          # exit 1 on any violation
//   bun run scripts/check-single-writer.ts --list   # every write found
//
// Tests (`__tests__/`, `*.test.ts`) are not scanned: they drive a connector on
// its own, without an engine.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");

/** Directories scanned, repo-relative. */
export const SCANNED_DIRS = [
  "packages/core/src",
  "packages/client/src",
  "apps/cli/src",
  "apps/web/src",
] as const;

/** Code under this prefix is the engine and may write. */
export const ENGINE_DIR = "packages/core/src/cp/application/engine/";

/** The connector fields the engine owns. */
export const GUARDED_FIELDS = new Set([
  "status",
  "availability",
  "scheduledAvailability",
  "currentErrorCode",
  "errorInfo",
  "vendorErrorCode",
  "transaction",
  "transactionId",
]);

/**
 * The fields of a `Transaction` (a connector's transaction is part of its
 * engine record). Guarded on a receiver whose text mentions "transaction" or
 * "tx": `transaction.stopTime = …`, `connector.transaction!.id = …`. Change
 * them with `connector.patchTransaction({...})`.
 */
export const TRANSACTION_FIELDS = new Set([
  "id",
  "startCallError",
  "connectorId",
  "tagId",
  "meterStart",
  "meterStop",
  "startTime",
  "stopTime",
  "meterSent",
  "cpTransactionId",
  "cpNextSeqNo",
  "cpLastTransactionEventChargingState",
  "reservationId",
  "remoteStartId",
  "startTriggerReason",
  "startChargingState",
  "signedBeginOcmf",
  "stopTriggerReason",
  "stopReason",
  "stoppedReason",
  "authorizationStatus",
  "authorizationRejectedMidSession",
  "batteryCapacityKwh",
  "initialSoc",
]);

export interface Write {
  readonly field: string;
  readonly line: number;
}

export interface Exemption {
  /** Repo-relative file. */
  readonly file: string;
  /** How many writes the file may still have. */
  readonly count: number;
  readonly reason: string;
}

/**
 * Writes that still go around the engine. Nothing here may grow; delete the
 * entry when the use is gone (the check fails on a stale one).
 */
export const EXEMPTIONS: readonly Exemption[] = [];

function isAssignment(node: ts.Node): ts.Expression | null {
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return node.left;
  }
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return node.operand;
  }
  return null;
}

/** The writes to guarded connector fields in one source text. */
export function scanSource(fileName: string, text: string): Write[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const writes: Write[] = [];
  const visit = (node: ts.Node): void => {
    const target = isAssignment(node);
    if (target) {
      let expression = target;
      while (ts.isParenthesizedExpression(expression)) {
        expression = expression.expression;
      }
      if (
        ts.isPropertyAccessExpression(expression) &&
        ((GUARDED_FIELDS.has(expression.name.text) &&
          /connector/i.test(expression.expression.getText(source))) ||
          (TRANSACTION_FIELDS.has(expression.name.text) &&
            /transaction|\btx\b/i.test(expression.expression.getText(source))))
      ) {
        writes.push({
          field: expression.name.text,
          line:
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return writes;
}

export interface Report {
  readonly violations: Array<{
    file: string;
    lines: readonly number[];
    allowed: number;
  }>;
  readonly stale: Array<{ exemption: Exemption; found: number }>;
}

export function evaluate(
  writesByFile: ReadonlyMap<string, readonly Write[]>,
  exemptions: readonly Exemption[] = EXEMPTIONS,
): Report {
  const allowed = new Map<string, number>();
  for (const e of exemptions) {
    allowed.set(e.file, (allowed.get(e.file) ?? 0) + e.count);
  }
  const violations: Report["violations"] = [];
  for (const [file, writes] of writesByFile) {
    if (file.startsWith(ENGINE_DIR)) continue;
    const limit = allowed.get(file) ?? 0;
    if (writes.length > limit) {
      violations.push({
        file,
        lines: writes.map((w) => w.line),
        allowed: limit,
      });
    }
  }
  const stale: Report["stale"] = [];
  for (const e of exemptions) {
    const found = writesByFile.get(e.file)?.length ?? 0;
    if (found < (allowed.get(e.file) ?? 0)) stale.push({ exemption: e, found });
  }
  return { violations, stale };
}

function isTestFile(path: string): boolean {
  return (
    path.includes(`${sep}__tests__${sep}`) ||
    /\.(bun\.)?(dom\.)?test\.tsx?$/.test(path) ||
    path.endsWith(".d.ts")
  );
}

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listSources(full));
    else if (/\.tsx?$/.test(name) && !isTestFile(full)) out.push(full);
  }
  return out.sort();
}

export function scanTree(root: string = REPO_ROOT): Map<string, Write[]> {
  const result = new Map<string, Write[]>();
  for (const dir of SCANNED_DIRS) {
    for (const file of listSources(join(root, dir))) {
      const rel = relative(root, file).split(sep).join("/");
      const writes = scanSource(rel, readFileSync(file, "utf8"));
      if (writes.length > 0) result.set(rel, writes);
    }
  }
  return result;
}

export function formatReport(report: Report): string {
  const lines: string[] = [];
  for (const v of report.violations) {
    lines.push(
      `${v.file}: ${v.lines.length} write(s) to connector state outside application/engine (allowed ${v.allowed}) at line ${v.lines.join(", ")}`,
    );
  }
  for (const s of report.stale) {
    lines.push(
      `${s.exemption.file}: exemption allows ${s.exemption.count} but ${s.found} remain; lower or delete it in scripts/check-single-writer.ts`,
    );
  }
  return lines.join("\n");
}

function main(argv: string[]): number {
  const found = scanTree();
  if (argv.includes("--list")) {
    for (const [file, writes] of found) {
      for (const w of writes) console.log(`${file}:${w.line} ${w.field}`);
    }
    return 0;
  }
  const report = evaluate(found);
  if (report.violations.length === 0 && report.stale.length === 0) {
    let engine = 0;
    for (const [file, writes] of found) {
      if (file.startsWith(ENGINE_DIR)) engine += writes.length;
    }
    console.log(
      `single writer OK: ${SCANNED_DIRS.length} directories scanned, ${engine} write(s) in application/engine, none outside`,
    );
    return 0;
  }
  console.error(formatReport(report));
  console.error(
    "\nConnector state is written by the charger engine only: call ChargePoint.updateConnectorStatus or dispatch an engine event; see docs/analyses/charger-engine.md.",
  );
  return 1;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
