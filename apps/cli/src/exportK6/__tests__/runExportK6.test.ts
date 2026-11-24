import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../engineBundle", () => ({
  loadEngineBundle: async () => "export const fake = true;\n",
}));

import { connectorsNeeded, runExportK6 } from "../runExportK6";
import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";

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

const args = (scenarioFile: string, extra: object = {}) => ({
  scenarioFile,
  outDir: join(dir, "out"),
  ocppVersion: "1.6" as const,
  chargersPerVu: 50,
  force: false,
  ...extra,
});

describe("runExportK6", () => {
  it("writes the engine, the scenario, the script and the README", async () => {
    const code = await runExportK6(args(writeScenario(VALID)));
    expect(code).toBe(0);
    const out = join(dir, "out");
    expect(readdirSync(out).sort()).toEqual([
      "README.md",
      "engine.js",
      "ids.example.json",
      "scenario.json",
      "script.js",
    ]);
    expect(readFileSync(join(out, "engine.js"), "utf8")).toContain("fake");
    expect(
      JSON.parse(readFileSync(join(out, "scenario.json"), "utf8")).id,
    ).toBe("t1");
    expect(readFileSync(join(out, "script.js"), "utf8")).toContain(
      "./engine.js",
    );
  });

  it("exports what the old runtime refused (the real engine runs it)", async () => {
    // A delay with a seeded jitter (schema 1.6) and a loop edge (1.10).
    const scenario = {
      ...VALID,
      nodes: [
        VALID.nodes[0],
        {
          id: "b",
          type: "delay",
          position: { x: 0, y: 0 },
          data: { label: "Wait", delaySeconds: 1, jitterSeconds: 1 },
        },
        VALID.nodes[2],
      ],
    };
    const code = await runExportK6(args(writeScenario(scenario)));
    expect(stderr.join("")).toBe("");
    expect(code).toBe(0);
  });

  it("reports unreadable and invalid input", async () => {
    expect(await runExportK6(args(join(dir, "missing.json")))).toBe(1);
    expect(stderr.join("")).toMatch(/cannot read scenario file/);
    stderr.length = 0;
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    expect(await runExportK6(args(bad))).toBe(1);
    expect(stderr.join("")).toMatch(/not valid JSON/);
  });

  it("does not throw on a JSON null or array", async () => {
    expect(await runExportK6(args(writeScenario(null)))).toBe(1);
    expect(await runExportK6(args(writeScenario([])))).toBe(1);
    expect(stderr.join("")).toMatch(/scenario.schema.json/);
  });

  it("needs a start node", async () => {
    const scenario = {
      ...VALID,
      nodes: VALID.nodes.filter((n) => n.type !== "start"),
      edges: [],
    };
    expect(await runExportK6(args(writeScenario(scenario)))).toBe(1);
    expect(stderr.join("")).toMatch(/no start node/);
  });

  it("refuses a non-empty output directory unless --force", async () => {
    const file = writeScenario(VALID);
    expect(await runExportK6(args(file))).toBe(0);
    expect(await runExportK6(args(file))).toBe(1);
    expect(stderr.join("")).toMatch(/--force/);
    expect(await runExportK6(args(file, { force: true }))).toBe(0);
  });
});

describe("connectorsNeeded", () => {
  const node = (connectorId?: number) =>
    ({
      id: "n",
      type: "transaction",
      position: { x: 0, y: 0 },
      data: connectorId ? { connectorId } : {},
    }) as never;
  it("is the highest connector the scenario names, at least 1", () => {
    expect(connectorsNeeded(undefined)).toBe(1);
    expect(
      connectorsNeeded({
        targetId: 2,
        nodes: [node(3), node()],
      } as unknown as ScenarioDefinition),
    ).toBe(3);
    expect(
      connectorsNeeded({ nodes: [] } as unknown as ScenarioDefinition),
    ).toBe(1);
  });
});
