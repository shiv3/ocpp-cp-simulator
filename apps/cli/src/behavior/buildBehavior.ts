import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { bundleBehavior, typecheckBehavior } from "./bundleBehavior";

export interface BuildBehaviorResult {
  readonly ok: boolean;
  readonly outFile: string | null;
  readonly problems: readonly string[];
}

/** `ocpp-cp-sim behavior build <file> [--out <file>]`. */
export async function buildBehaviorFile(
  file: string,
  out?: string,
): Promise<BuildBehaviorResult> {
  if (!existsSync(file)) {
    return { ok: false, outFile: null, problems: [`No such file: ${file}`] };
  }
  const typeProblems = typecheckBehavior(path.resolve(file));
  if (typeProblems.length > 0) {
    return { ok: false, outFile: null, problems: typeProblems };
  }
  const bundled = await bundleBehavior(file, { mode: "build" });
  if (!bundled.ok) {
    return { ok: false, outFile: null, problems: bundled.problems };
  }
  const resolved = path.resolve(file);
  const outFile = out
    ? path.resolve(out)
    : path.join(
        path.dirname(resolved),
        `${path.basename(resolved).replace(/\.[^.]+$/, "")}.bundle.js`,
      );
  writeFileSync(outFile, bundled.code);
  return { ok: true, outFile, problems: [] };
}

export const BEHAVIOR_USAGE = `Usage: ocpp-cp-sim behavior build <file> [--out <file>]
  Type-checks the behavior (ES2017 libraries, strict), refuses \`for await\`,
  async generators and \`using\`, and writes one ESM bundle with \`k6/*\` external
  and ES2017 output. Default output: <name>.bundle.js next to the source.`;

export type BehaviorArgs =
  { ok: true; file: string; out?: string } | { ok: false; message: string };

export function parseBehaviorArgs(argv: string[]): BehaviorArgs {
  const [sub, ...rest] = argv;
  if (sub !== "build") {
    return {
      ok: false,
      message: `Unknown behavior command: ${sub ?? ""}\n${BEHAVIOR_USAGE}`,
    };
  }
  let file: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--out" || arg === "-o") {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("-")) {
        return {
          ok: false,
          message: `Error: ${arg} requires a value\n${BEHAVIOR_USAGE}`,
        };
      }
      out = next;
      i++;
    } else if (arg.startsWith("-") || file !== undefined) {
      return {
        ok: false,
        message: `Unknown option: ${arg}\n${BEHAVIOR_USAGE}`,
      };
    } else {
      file = arg;
    }
  }
  if (file === undefined) {
    return {
      ok: false,
      message: `Error: <file> is required\n${BEHAVIOR_USAGE}`,
    };
  }
  return { ok: true, file, ...(out === undefined ? {} : { out }) };
}
