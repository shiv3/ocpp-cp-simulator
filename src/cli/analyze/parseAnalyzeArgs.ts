/**
 * Argument parser for the `analyze` subcommand.
 *
 * Kept out of main.ts's `parseArgs()` switch and its own module (rather than
 * inline in main.ts's early dispatch) so the flag/format edge cases are unit
 * testable without spawning a `bun` subprocess for each one. It returns a
 * result object instead of calling `process.exit()` itself for the same
 * reason: a pure function is trivial to assert against in vitest.
 */

export interface AnalyzeCliArgs {
  file: string;
  output?: string;
  format?: "html" | "markdown";
}

export type AnalyzeCliParseResult =
  { ok: true; args: AnalyzeCliArgs } | { ok: false; message: string };

export const ANALYZE_USAGE =
  "Usage: ocpp-cp-sim analyze <trace.jsonl> [--output <file>] [--format html|markdown]";

export function parseAnalyzeArgs(argv: string[]): AnalyzeCliParseResult {
  let file: string | undefined;
  let output: string | undefined;
  let format: "html" | "markdown" | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--output" || arg === "-o") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        return { ok: false, message: `Error: ${arg} requires a value` };
      }
      output = next;
      i++;
    } else if (arg === "--format") {
      const next = argv[i + 1];
      if (next !== "html" && next !== "markdown") {
        return {
          ok: false,
          message: "Error: --format must be 'html' or 'markdown'",
        };
      }
      format = next;
      i++;
    } else if (arg.startsWith("-")) {
      return { ok: false, message: `Unknown option: ${arg}` };
    } else if (file === undefined) {
      file = arg;
    } else {
      // A second positional argument: analyze only takes one trace file.
      return { ok: false, message: `Unknown option: ${arg}` };
    }
  }

  if (!file) {
    return {
      ok: false,
      message: `Error: analyze requires a trace file path\n${ANALYZE_USAGE}`,
    };
  }

  return { ok: true, args: { file, output, format } };
}
