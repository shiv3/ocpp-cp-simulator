// export-k6 end to end, under Bun: the real engine bundle is built and the
// behaviors are really bundled (needs Bun.build), so this is not a vitest.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runExportK6 } from "../runExportK6";

const repoRoot = resolve(import.meta.dir, "../../../../..");
let dir: string;
let stderr: string[];
const realWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "export-k6-bun-"));
  stderr = [];
  process.stderr.write = ((s: string) => {
    stderr.push(String(s));
    return true;
  }) as typeof process.stderr.write;
});
afterEach(() => {
  process.stderr.write = realWrite;
  rmSync(dir, { recursive: true, force: true });
});

const args = (extra: object) => ({
  scenarioFile: "",
  outDir: join(dir, "out"),
  ocppVersion: "1.6" as const,
  chargersPerVu: 50,
  force: false,
  ...extra,
});

describe("export-k6 with the real engine", () => {
  it("exports a bundled scenario with the engine, byte for byte what k6 will run", async () => {
    const code = await runExportK6(
      args({
        scenarioFile: join(
          repoRoot,
          "scripts/verify/k6/quick-charging-cycle.json",
        ),
      }),
    );
    expect(stderr.join("")).toBe("");
    expect(code).toBe(0);
    const engine = readFileSync(join(dir, "out/engine.js"), "utf8");
    expect(engine.length).toBeGreaterThan(500_000);
    expect(engine).toContain("k6/websockets");
    const script = readFileSync(join(dir, "out/script.js"), "utf8");
    expect(script).toContain("quick-charging-cycle");
  });

  it("exports a behavior and keeps its bundle", async () => {
    const code = await runExportK6(
      args({
        behaviorFiles: [join(repoRoot, "examples/behaviors/heartbeat-loop.ts")],
      }),
    );
    expect(stderr.join("")).toBe("");
    expect(code).toBe(0);
    expect(
      existsSync(join(dir, "out/behaviors/01-heartbeat-loop.bundle.js")),
    ).toBe(true);
    expect(existsSync(join(dir, "out/scenario.json"))).toBe(false);
    expect(readFileSync(join(dir, "out/script.js"), "utf8")).toContain(
      'import behavior0 from "./behaviors/01-heartbeat-loop.bundle.js"',
    );
  });

  it("refuses a behavior this station cannot load, naming the reason", async () => {
    const code = await runExportK6(
      args({
        behaviorFiles: [join(import.meta.dir, "behaviors/needsVersion2.ts")],
      }),
    );
    expect(code).toBe(1);
    expect(stderr.join("")).toContain('behavior "needs-2x"');
  });
});
