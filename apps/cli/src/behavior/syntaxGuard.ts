import ts from "typescript";

/**
 * Syntax a behavior must not use because it hangs silently on k6 (its JS
 * engine has no async iteration protocol and no explicit resource
 * management): `for await`, async generators, `using` / `await using`.
 */
export interface SyntaxProblem {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export function findForbiddenSyntax(
  fileName: string,
  text: string,
): SyntaxProblem[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const problems: SyntaxProblem[] = [];
  const report = (node: ts.Node, message: string): void => {
    const { line, character } = source.getLineAndCharacterOfPosition(
      node.getStart(source),
    );
    problems.push({
      file: fileName,
      line: line + 1,
      column: character + 1,
      message,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isForOfStatement(node) && node.awaitModifier) {
      report(node, "`for await` hangs silently on k6; use a plain loop");
    }
    if (
      ts.isFunctionLike(node) &&
      "asteriskToken" in node &&
      node.asteriskToken &&
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
    ) {
      report(
        node,
        "async generators hang silently on k6; use a plain function",
      );
    }
    if (
      ts.isVariableDeclarationList(node) &&
      (node.flags & ts.NodeFlags.Using) !== 0
    ) {
      report(node, "`using` / `await using` is not supported on k6");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}
