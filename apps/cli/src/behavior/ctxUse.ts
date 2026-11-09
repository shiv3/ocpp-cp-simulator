import ts from "typescript";
import type { Behavior } from "@ocpp-cp-simulator/contracts/behavior";

/** The `ctx` members that need a capability in `requires`. */
const NEEDS: Readonly<Record<string, "physical" | "raw-frames">> = {
  plugIn: "physical",
  unplug: "physical",
  authorize: "physical",
  startCharging: "physical",
  stopCharging: "physical",
  setConnectorStatus: "physical",
  raw: "raw-frames",
};

const isCtx = (node: ts.Expression): boolean =>
  ts.isIdentifier(node) && /^ctx\d*$/.test(node.text);

/**
 * `ctx.plugIn`, `ctx["raw"]` and `const { raw } = ctx` in `code`, as the
 * capability each needs. Syntactic: an alias (`const c = ctx; c.raw(...)`)
 * is not seen here and still fails at the call.
 */
export function ctxCapabilityUses(code: string): Map<string, string> {
  const uses = new Map<string, string>();
  const note = (member: string): void => {
    const need = Object.hasOwn(NEEDS, member) ? NEEDS[member] : undefined;
    if (need) uses.set(member, need);
  };
  const source = ts.createSourceFile(
    "behavior.js",
    code,
    ts.ScriptTarget.ES2017,
    true,
    ts.ScriptKind.JS,
  );
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && isCtx(node.expression)) {
      note(node.name.text);
    } else if (
      ts.isElementAccessExpression(node) &&
      isCtx(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      note(node.argumentExpression.text);
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      isCtx(node.initializer) &&
      ts.isObjectBindingPattern(node.name)
    ) {
      for (const element of node.name.elements) {
        const key = element.propertyName ?? element.name;
        if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) note(key.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return uses;
}

/**
 * Why a file must be refused at load: it uses a `ctx` member that needs a
 * capability none of its behaviors lists. Null when it is fine.
 */
export function missingCapabilityProblem(
  file: string,
  code: string,
  behaviors: readonly Behavior[],
): string | null {
  const listed = new Set<string>(behaviors.flatMap((b) => b.requires ?? []));
  const missing: string[] = [];
  for (const [member, need] of ctxCapabilityUses(code)) {
    if (!listed.has(need)) {
      missing.push(`ctx.${member} needs "${need}" in requires`);
    }
  }
  return missing.length === 0
    ? null
    : `${file}: ${missing.join("; ")} (no behavior in the file lists it)`;
}
