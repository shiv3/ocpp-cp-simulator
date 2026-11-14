import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { findForbiddenSyntax, type SyntaxProblem } from "./syntaxGuard";
import { isBun } from "../runtime";

export interface BundleResult {
  readonly ok: boolean;
  /** The one ESM bundle, when `ok`. */
  readonly code: string;
  readonly problems: readonly string[];
}

export interface BundleOptions {
  /**
   * `build`: reject syntax that hangs on k6 and lower the output to ES2017.
   * `load`: bundle for this process only (Bun runs everything).
   */
  readonly mode: "build" | "load";
}

const SOURCE_FILTER = /\.(?:[cm]?[tj]s|tsx?)$/;

/**
 * Bundling uses `Bun.build`, so it needs Bun (#916). On Node, `behavior build`
 * and loading a behavior file fail with this instead of a TypeError; null when
 * the runtime can bundle.
 */
export function behaviorBundlingUnavailable(
  mode: BundleOptions["mode"],
): string | null {
  if (isBun) return null;
  return mode === "build"
    ? "`behavior build` needs Bun (run the CLI under Bun, e.g. `bunx --bun ocpp-cp-simulator behavior build ...`): https://bun.sh"
    : "Loading a behavior file needs Bun (run the CLI under Bun, e.g. `bunx --bun ocpp-cp-simulator ...`): https://bun.sh";
}

const formatProblem = (p: SyntaxProblem): string =>
  `${p.file}:${p.line}:${p.column}: ${p.message}`;

/** `k6` and `k6/*` come from the k6 host and have no types here. */
function isK6ModuleDiagnostic(d: ts.Diagnostic): boolean {
  if (d.code !== 2307 && d.code !== 7016) return false;
  const text = ts.flattenDiagnosticMessageText(d.messageText, "\n");
  return /'k6(\/[^']*)?'/.test(text);
}

/**
 * Type-check `file` with the strictest settings a behavior has to meet: ES2017
 * libraries only (so `AbortController`, `structuredClone`, `performance` and
 * friends are errors, as they are on k6), `strict`, no ambient types.
 * Returns the formatted diagnostics; a `.js` file is not checked.
 */
export function typecheckBehavior(file: string): string[] {
  if (!/\.[cm]?tsx?$/.test(file)) return [];
  const program = ts.createProgram([file], {
    target: ts.ScriptTarget.ES2017,
    lib: ["lib.es2017.d.ts"],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: [],
  });
  // The syntax k6 hangs on is reported first and alone: with the ES2017 lib
  // the same constructs only show up as confusing "cannot find name" errors.
  const syntax: string[] = [];
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    if (source.fileName.includes("/node_modules/")) continue;
    for (const p of findForbiddenSyntax(source.fileName, source.text)) {
      syntax.push(formatProblem(p));
    }
  }
  if (syntax.length > 0) return syntax;
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .filter((d) => !isK6ModuleDiagnostic(d))
    .map((d) => {
      const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
      if (!d.file || d.start === undefined) return message;
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
      return `${d.file.fileName}:${line + 1}:${character + 1}: TS${d.code}: ${message}`;
    });
}

/** Bundle a behavior file into one ESM module; `k6/*` stays external. */
export async function bundleBehavior(
  file: string,
  options: BundleOptions,
): Promise<BundleResult> {
  const unavailable = behaviorBundlingUnavailable(options.mode);
  if (unavailable) return { ok: false, code: "", problems: [unavailable] };
  const entry = path.resolve(file);
  const problems: string[] = [];
  const plugin: Bun.BunPlugin = {
    name: "behavior-source",
    setup(build) {
      build.onLoad({ filter: SOURCE_FILTER }, (args) => {
        if (args.path.includes(`${path.sep}node_modules${path.sep}`)) {
          return undefined;
        }
        const text = readFileSync(args.path, "utf8");
        if (options.mode === "load") return undefined;
        for (const p of findForbiddenSyntax(args.path, text)) {
          problems.push(formatProblem(p));
        }
        const out = ts.transpileModule(text, {
          fileName: args.path,
          compilerOptions: {
            target: ts.ScriptTarget.ES2017,
            module: ts.ModuleKind.ESNext,
            sourceMap: false,
            inlineSourceMap: false,
            importsNotUsedAsValues: undefined,
          },
        });
        return { contents: out.outputText, loader: "js" };
      });
    },
  };
  let result: Bun.BuildOutput;
  try {
    result = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      format: "esm",
      external: ["k6", "k6/*"],
      plugins: [plugin],
      minify: false,
    });
  } catch (error) {
    const logs =
      error instanceof AggregateError
        ? error.errors.map((e: unknown) => String(e))
        : [String(error)];
    return { ok: false, code: "", problems: [...problems, ...logs] };
  }
  if (!result.success) {
    return {
      ok: false,
      code: "",
      problems: [...problems, ...result.logs.map((l) => l.message)],
    };
  }
  if (problems.length > 0) return { ok: false, code: "", problems };
  const output = result.outputs[0];
  if (!output) return { ok: false, code: "", problems: ["no output"] };
  return { ok: true, code: await output.text(), problems: [] };
}
