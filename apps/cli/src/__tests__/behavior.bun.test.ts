import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildBehaviorFile,
  parseBehaviorArgs,
} from "../behavior/buildBehavior";
import { behaviorFlagProblem } from "../behavior/flags";
import {
  loadBehaviorFile,
  loadBehaviorFiles,
} from "../behavior/loadBehaviorFile";
import { findForbiddenSyntax } from "../behavior/syntaxGuard";

const repo = path.resolve(import.meta.dir, "../../../..");
const example = path.join(repo, "examples/behaviors/flaky-firmware.ts");
const main = path.join(repo, "apps/cli/src/main.ts");

const dir = mkdtempSync(path.join(tmpdir(), "behavior-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, text: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, text);
  return file;
}

const HEADER = `import type { Behavior } from "${repo}/packages/contracts/src/behavior";\n`;

describe("behaviorFlagProblem", () => {
  const base = {
    serverMode: true,
    behaviorFiles: ["a.ts"],
    allowBehaviorCode: true,
    unsafeRemote: false,
  };
  test("a daemon with --behavior needs --allow-behavior-code", () => {
    expect(behaviorFlagProblem({ ...base, allowBehaviorCode: false })).toMatch(
      /--allow-behavior-code/,
    );
    expect(behaviorFlagProblem(base)).toBeNull();
  });
  test("a single charge point does not need the opt-in", () => {
    expect(
      behaviorFlagProblem({
        ...base,
        serverMode: false,
        allowBehaviorCode: false,
      }),
    ).toBeNull();
  });
  test("--allow-behavior-code and --unsafe-remote never go together", () => {
    expect(behaviorFlagProblem({ ...base, unsafeRemote: true })).toMatch(
      /cannot be combined with --unsafe-remote/,
    );
    expect(
      behaviorFlagProblem({ ...base, behaviorFiles: [], unsafeRemote: true }),
    ).toMatch(/--unsafe-remote/);
  });
  test("--unsafe-remote alone is fine", () => {
    expect(
      behaviorFlagProblem({
        serverMode: true,
        behaviorFiles: [],
        allowBehaviorCode: false,
        unsafeRemote: true,
      }),
    ).toBeNull();
  });
});

describe("the real CLI refuses", () => {
  const run = (...args: string[]) =>
    Bun.spawnSync(["bun", main, ...args], { stderr: "pipe", stdout: "pipe" });
  test("daemon --behavior without --allow-behavior-code", () => {
    const r = run("--daemon", "--behavior", example);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("--allow-behavior-code");
  });
  test("--allow-behavior-code with --unsafe-remote", () => {
    const r = run(
      "--daemon",
      "--behavior",
      example,
      "--allow-behavior-code",
      "--unsafe-remote",
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain(
      "cannot be combined with --unsafe-remote",
    );
  });
  test("--behavior with a client mode", () => {
    const r = run("--stop", "--behavior", example);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("--behavior");
  });
  test("a behavior file that does not load stops the start", () => {
    const bad = write("bad.ts", "export default { nope: true };\n");
    const r = run(
      "--cp-id",
      "X",
      "--ws-url",
      "ws://127.0.0.1:1/",
      "--json",
      "--behavior",
      bad,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("default export must be a behavior");
  });
});

describe("loadBehaviorFile", () => {
  test("loads the template", async () => {
    const [b] = await loadBehaviorFile(example);
    expect(b!.id).toBe("flaky-firmware");
    expect(b!.onCall).toHaveProperty("UpdateFirmware");
  });
  test("accepts an array, rejects a duplicate id across files", async () => {
    const a = write(
      "two.ts",
      `export default [{ api: 1, id: "x" }, { api: 1, id: "y" }];\n`,
    );
    expect((await loadBehaviorFile(a)).map((b) => b.id)).toEqual(["x", "y"]);
    const c = write("dup.ts", `export default { api: 1, id: "x" };\n`);
    await expect(loadBehaviorFiles([a, c])).rejects.toThrow(/loaded twice/);
  });
  test("a syntax error names the file", async () => {
    const f = write("syntax.ts", "export default {{{\n");
    await expect(loadBehaviorFile(f)).rejects.toThrow(/syntax\.ts/);
  });
});

describe("behavior build", () => {
  test("parses its arguments", () => {
    expect(parseBehaviorArgs(["build", "a.ts", "--out", "b.js"])).toEqual({
      ok: true,
      file: "a.ts",
      out: "b.js",
    });
    expect(parseBehaviorArgs(["build"]).ok).toBe(false);
    expect(parseBehaviorArgs(["bundle", "a.ts"]).ok).toBe(false);
    expect(parseBehaviorArgs(["build", "a.ts", "--out"]).ok).toBe(false);
  });

  test("builds the template to ES2017 with k6/* external", async () => {
    const out = path.join(dir, "template.bundle.js");
    const r = await buildBehaviorFile(example, out);
    expect(r.problems).toEqual([]);
    expect(r.outFile).toBe(out);
    const code = readFileSync(out, "utf8");
    expect(code).toContain("flaky-firmware");
    expect(code).not.toMatch(/\?\.|\?\?/);
    // The bundle is a working module.
    const mod = await import(out);
    expect(mod.default.id).toBe("flaky-firmware");
  });

  test("lowers newer syntax and leaves k6 imports alone", async () => {
    const f = write(
      "k6.ts",
      HEADER +
        `import { check } from "k6";\n` +
        `import { sleep } from "k6/x/whatever";\n` +
        `export default { api: 1, id: "k", t: [check, sleep], v: ({} as any)?.a ?? 1 } as Behavior;\n`,
    );
    const r = await buildBehaviorFile(f);
    expect(r.problems).toEqual([]);
    expect(r.outFile).toBe(path.join(dir, "k6.bundle.js"));
    const code = readFileSync(r.outFile!, "utf8");
    expect(code).toContain(`from "k6"`);
    expect(code).toContain(`from "k6/x/whatever"`);
    expect(code).not.toMatch(/\?\.|\?\?/);
  });

  test("type errors fail before bundling", async () => {
    const f = write(
      "types.ts",
      HEADER +
        `export default { api: 2, id: "t" } as Behavior;\nconst n: number = "s";\n`,
    );
    const r = await buildBehaviorFile(f);
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/TS\d+/);
  });

  test("APIs k6 lacks are type errors", async () => {
    const f = write(
      "abort.ts",
      HEADER +
        `const c = new AbortController();\nexport default { api: 1, id: "a", c } as unknown as Behavior;\n`,
    );
    const r = await buildBehaviorFile(f);
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain("AbortController");
  });

  for (const [name, body, message] of [
    [
      "for-await",
      `export async function f(xs: AsyncIterable<number>) { for await (const x of xs) { void x; } }`,
      /for await/,
    ],
    [
      "async-gen",
      `export async function* g() { yield 1; }`,
      /async generators/,
    ],
    [
      "using",
      `export function u(r: { [Symbol.dispose](): void }) { using x = r; void x; }`,
      /using/,
    ],
  ] as const) {
    test(`refuses ${name}, also in an imported file`, async () => {
      write(`${name}-lib.ts`, body + "\n");
      const f = write(
        `${name}.ts`,
        HEADER +
          `import * as lib from "./${name}-lib";\nexport default { api: 1, id: "${name}", lib } as unknown as Behavior;\n`,
      );
      const r = await buildBehaviorFile(f);
      expect(r.ok).toBe(false);
      expect(r.problems.join("\n")).toMatch(message);
      expect(r.problems.join("\n")).toContain(`${name}-lib.ts`);
    });
  }

  test("the guard finds all three and nothing in plain code", () => {
    expect(
      findForbiddenSyntax(
        "x.ts",
        `async function* g(){}\nasync function f(a:any){ for await (const x of a){} }`,
      ),
    ).toHaveLength(2);
    expect(
      findForbiddenSyntax(
        "x.ts",
        `async function f(a:any[]){ for (const x of a){ await x; } const g = async () => 1; function* h(){ yield 1; } }`,
      ),
    ).toEqual([]);
  });

  test("a missing file is an error, not a crash", async () => {
    const r = await buildBehaviorFile(path.join(dir, "missing.ts"));
    expect(r.ok).toBe(false);
  });
});
