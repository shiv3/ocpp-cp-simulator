import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runExportK6 } from "../runExportK6";
import { RUNTIME_FILES } from "../runtimeManifest";

const VALID = {
  schemaVersion: "1.0",
  id: "t1",
  name: "T1",
  targetType: "connector",
  targetId: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  nodes: [
    {
      id: "a",
      type: "start",
      position: { x: 0, y: 0 },
      data: { label: "Start" },
    },
    {
      id: "b",
      type: "statusChange",
      position: { x: 0, y: 0 },
      data: { label: "Preparing", status: "Preparing" },
    },
    { id: "c", type: "end", position: { x: 0, y: 0 }, data: { label: "End" } },
  ],
  edges: [
    { id: "e1", source: "a", target: "b" },
    { id: "e2", source: "b", target: "c" },
  ],
};

let dir: string;
let stderr: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "export-k6-"));
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    stderr.push(String(s));
    return true;
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function writeScenario(value: unknown): string {
  const file = join(dir, "scenario-in.json");
  writeFileSync(file, JSON.stringify(value));
  return file;
}

describe("runExportK6", () => {
  it("writes the full bundle for a valid scenario", async () => {
    const code = await runExportK6({
      scenarioFile: writeScenario(VALID),
      outDir: join(dir, "out"),
      ocppVersion: "1.6",
      force: false,
    });
    expect(code).toBe(0);
    const out = join(dir, "out");
    expect(readdirSync(out).sort()).toEqual(
      [
        "README.md",
        "ids.example.json",
        "ocpp-runtime",
        "scenario.json",
        "scenario.k6.ts",
      ].sort(),
    );
    for (const f of RUNTIME_FILES) {
      expect(() => readFileSync(join(out, "ocpp-runtime", f))).not.toThrow();
    }
    expect(readFileSync(join(out, "scenario.k6.ts"), "utf8")).toContain(
      "T1 (t1)",
    );
    expect(
      JSON.parse(readFileSync(join(out, "scenario.json"), "utf8")).id,
    ).toBe("t1");
  });

  it("fails on invalid JSON", async () => {
    const file = join(dir, "bad.json");
    writeFileSync(file, "{nope");
    const code = await runExportK6({
      scenarioFile: file,
      outDir: join(dir, "out"),
      ocppVersion: "1.6",
      force: false,
    });
    expect(code).toBe(1);
    expect(stderr.join("")).toMatch(/JSON/i);
  });

  it("fails on an unknown node type", async () => {
    const bad = {
      ...VALID,
      nodes: [
        ...VALID.nodes,
        {
          id: "x",
          type: "teleport",
          position: { x: 0, y: 0 },
          data: { label: "X" },
        },
      ],
    };
    const code = await runExportK6({
      scenarioFile: writeScenario(bad),
      outDir: join(dir, "out"),
      ocppVersion: "1.6",
      force: false,
    });
    expect(code).toBe(1);
    expect(stderr.join("")).toMatch(/teleport/);
  });

  it("fails on a missing start node", async () => {
    const bad = {
      ...VALID,
      nodes: VALID.nodes.filter((n) => n.type !== "start"),
    };
    const code = await runExportK6({
      scenarioFile: writeScenario(bad),
      outDir: join(dir, "out"),
      ocppVersion: "1.6",
      force: false,
    });
    expect(code).toBe(1);
    expect(stderr.join("")).toMatch(/start/);
  });

  it("refuses a non-empty out dir without --force and honors --force", async () => {
    const out = join(dir, "out");
    const okArgs = {
      scenarioFile: writeScenario(VALID),
      outDir: out,
      ocppVersion: "1.6" as const,
      force: false,
    };
    expect(await runExportK6(okArgs)).toBe(0);
    expect(await runExportK6(okArgs)).toBe(1);
    expect(stderr.join("")).toMatch(/--force/);
    expect(await runExportK6({ ...okArgs, force: true })).toBe(0);
  });
});
