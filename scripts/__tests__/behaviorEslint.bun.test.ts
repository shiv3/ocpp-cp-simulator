import { describe, expect, test } from "bun:test";
import path from "node:path";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import behaviorConfig from "../../packages/contracts/eslint/behavior.js";

const repo = path.resolve(import.meta.dir, "../..");

const eslint = new ESLint({
  cwd: repo,
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ["**/*.ts"],
      languageOptions: { parser: tseslint.parser },
    },
    ...behaviorConfig,
  ],
});

async function rules(code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, {
    filePath: path.join(repo, "behaviors/x.ts"),
  });
  return result!.messages.map((m) => `${m.ruleId}: ${m.message}`);
}

describe("behavior ESLint config", () => {
  test.each([
    ["Date", "export const t = new Date();"],
    ["Date.now", "export const t = Date.now();"],
    ["Math.random", "export const r = () => Math.random();"],
    ["setTimeout", "export const f = () => setTimeout(() => {}, 1);"],
    ["setInterval", "export const f = () => setInterval(() => {}, 1);"],
    ["performance", "export const f = () => performance.now();"],
    ["module-scope let", "let n = 0;\nexport const f = () => n++;"],
    ["module-scope var", "var n = 0;\nexport const f = () => n++;"],
    ["exported let", "export let n = 0;"],
    [
      "module-scope Map",
      "const seen = new Map<string, number>();\nexport const f = () => seen;",
    ],
    [
      "module-scope Set",
      "const seen = new Set<string>();\nexport const f = () => seen;",
    ],
    ["empty array", "const log: string[] = [];\nexport const f = () => log;"],
    [
      "empty object",
      "const cache: Record<string, number> = {};\nexport const f = () => cache;",
    ],
    [
      "for await",
      "export async function f(a: AsyncIterable<number>) { for await (const x of a) { void x; } }",
    ],
    ["async generator", "export async function* g() { yield 1; }"],
    ["randomUUID", "export const u = () => crypto.randomUUID();"],
  ])("reports %s", async (_name, code) => {
    expect((await rules(code)).length).toBeGreaterThan(0);
  });

  test("lets plain behavior code through", async () => {
    const code = `
const RATE = 0.3;
const PLAN = [["a", 1], ["b", 2]] as const;
export async function run(ctx: { now(): number; sleep(ms: number): Promise<void>; state: Record<string, number> }) {
  for (const [, ms] of PLAN) { await ctx.sleep(ms); }
  ctx.state.at = ctx.now();
  let local = 0;
  local += RATE;
  return local;
}
`;
    expect(await rules(code)).toEqual([]);
  });

  test("the template behavior is clean", async () => {
    const [result] = await eslint.lintFiles([
      path.join(repo, "examples/behaviors/flaky-firmware.ts"),
    ]);
    expect(result!.messages).toEqual([]);
  });
});
