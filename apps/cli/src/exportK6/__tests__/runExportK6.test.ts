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

  it("fails cleanly when the scenario file contains null", async () => {
    const file = join(dir, "null.json");
    writeFileSync(file, "null");
    const code = await runExportK6({
      scenarioFile: file,
      outDir: join(dir, "out"),
      ocppVersion: "1.6",
      force: false,
    });
    expect(code).toBe(1);
    expect(stderr.join("")).toMatch(/schema/i);
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

  it("fails on a connectionTrigger node (#240, not yet supported by export)", async () => {
    const bad = {
      ...VALID,
      nodes: [
        ...VALID.nodes,
        {
          id: "y",
          type: "connectionTrigger",
          position: { x: 0, y: 0 },
          data: { label: "Y" },
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
    expect(stderr.join("")).toContain(
      'unsupported node type "connectionTrigger"',
    );
  });

  describe("schema 1.5 behavior features are refused, never ignored (#566)", () => {
    const withNode = (type: string, data: Record<string, unknown>) => ({
      ...VALID,
      nodes: [
        ...VALID.nodes,
        {
          id: "x",
          type,
          position: { x: 0, y: 0 },
          data: { label: "X", ...data },
        },
      ],
    });

    async function refuse(scenario: unknown): Promise<string> {
      const code = await runExportK6({
        scenarioFile: writeScenario(scenario),
        outDir: join(dir, "out"),
        ocppVersion: "1.6",
        force: false,
      });
      expect(code).toBe(1);
      expect(readdirSync(dir)).not.toContain("out");
      return stderr.join("");
    }

    it("callResponse", async () => {
      const message = await refuse(
        withNode("callResponse", { kind: "result", payload: {} }),
      );
      expect(message).toContain(
        'unsupported node type "callResponse" (node x)',
      );
      expect(message).toContain("station behavior engine");
    });

    it("useBehavior", async () => {
      const message = await refuse(
        withNode("useBehavior", { behaviorId: "my-behavior" }),
      );
      expect(message).toContain('unsupported node type "useBehavior" (node x)');
    });

    it.each([
      ["notify", { kind: "firmwareStatus", status: "Installed" }],
      ["switch", { value: 1, cases: [1] }],
      ["choice", { options: [{}, {}] }],
      ["setState", { key: "k", value: 1 }],
    ])("%s (schema 1.6, #654)", async (type, data) => {
      const message = await refuse(withNode(type, data));
      expect(message).toContain(`unsupported node type "${type}" (node x)`);
      expect(message).toContain("k6 runtime does not have");
    });

    it.each([{ until: "2030-01-01T00:00:00.000Z" }, { jitterSeconds: 2 }])(
      "delay with %j (schema 1.6, #654)",
      async (extra) => {
        const message = await refuse(
          withNode("delay", { delaySeconds: 1, ...extra }),
        );
        expect(message).toContain("not supported by export-k6 (node x)");
      },
    );

    it("useBehavior with params or mode disable (schema 1.6)", async () => {
      for (const data of [
        { behaviorId: "default.firmware", params: { stepMs: 500 } },
        { behaviorId: "default.firmware", mode: "disable" },
      ]) {
        const message = await refuse(withNode("useBehavior", data));
        expect(message).toContain(
          'unsupported node type "useBehavior" (node x)',
        );
        expect(message).toContain("params");
        expect(message).toContain("disable");
      }
    });

    it("csmsCallTrigger with behavior replace", async () => {
      const message = await refuse(
        withNode("csmsCallTrigger", { action: "Reset", behavior: "replace" }),
      );
      expect(message).toContain(
        'behavior "replace" is not supported by export-k6',
      );
      expect(message).toContain("node x");
    });

    it("an onBusy without replace", async () => {
      const message = await refuse(
        withNode("csmsCallTrigger", {
          action: "Reset",
          onBusy: { kind: "none" },
        }),
      );
      expect(message).toContain("onBusy");
    });

    it("an ocppCall payload that reads $from", async () => {
      const message = await refuse(
        withNode("ocppCall", {
          action: "FirmwareStatusNotification",
          payload: { status: { $from: "call.payload.status" } },
        }),
      );
      expect(message).toContain('"$from"');
    });

    it("still exports csmsCallTrigger with behavior observe", async () => {
      const code = await runExportK6({
        scenarioFile: writeScenario(
          withNode("csmsCallTrigger", { action: "Reset", behavior: "observe" }),
        ),
        outDir: join(dir, "out"),
        ocppVersion: "1.6",
        force: false,
      });
      expect(code).toBe(0);
    });
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

  it("fails cleanly when --out points at an existing regular file", async () => {
    const outFile = join(dir, "not-a-dir");
    writeFileSync(outFile, "I am a file, not a directory");
    const code = await runExportK6({
      scenarioFile: writeScenario(VALID),
      outDir: outFile,
      ocppVersion: "1.6",
      force: false,
    });
    expect(code).toBe(1);
    expect(stderr.join("")).toContain(
      `${outFile} exists and is not a directory`,
    );
  });

  it("fails cleanly when nodes contains a null element", async () => {
    const bad = {
      ...VALID,
      nodes: [...VALID.nodes, null],
    };
    const code = await runExportK6({
      scenarioFile: writeScenario(bad),
      outDir: join(dir, "out"),
      ocppVersion: "1.6",
      force: false,
    });
    expect(code).toBe(1);
    expect(stderr.join("")).toMatch(/node at index 3 is not an object/);
  });
});
