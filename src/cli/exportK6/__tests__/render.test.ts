// src/cli/exportK6/__tests__/render.test.ts
import { describe, expect, it } from "vitest";
import {
  renderEntryScript,
  renderIdsExample,
  renderReadme,
} from "../emit/render";
import type { ScenarioJson } from "../runtime/types";

const LINE_SEPARATOR = "\u2028";
const PARAGRAPH_SEPARATOR = "\u2029";

const scenario: ScenarioJson = {
  id: "charge-1",
  name: "Simple Charge",
  targetId: 1,
  nodes: [
    { id: "a", type: "start", data: { label: "Start" } },
    {
      id: "b",
      type: "statusChange",
      data: { label: "Set Preparing", status: "Preparing" },
    },
    { id: "c", type: "end", data: { label: "End" } },
  ],
  edges: [
    { source: "a", target: "b" },
    { source: "b", target: "c" },
  ],
};

describe("renderEntryScript", () => {
  const entry = renderEntryScript(scenario, { ocppVersion: "1.6" });

  it("summarizes the steps as comments", () => {
    expect(entry).toContain("// Scenario: Simple Charge (charge-1)");
    expect(entry).toContain("Set Preparing (statusChange)");
  });

  it("loads the scenario via open() and wires the runtime", () => {
    expect(entry).toContain('JSON.parse(open("./scenario.json"))');
    expect(entry).toContain('from "./ocpp-runtime/index"');
    expect(entry).toContain("buildOptions(__ENV)");
    expect(entry).toContain('createWire(__ENV.OCPP_VERSION ?? "1.6")');
  });

  it("documents the k6 version requirement", () => {
    expect(entry).toContain("Requires k6 >= v1.6.0");
  });

  it("is a stable artifact (golden)", () => {
    expect(entry).toMatchSnapshot();
  });
});

describe("renderEntryScript with scenario-derived text containing line terminators", () => {
  const evilScenario: ScenarioJson = {
    id: `evil${LINE_SEPARATOR}id`,
    name: 'Evil\nName */ console.log("pwned"); /*',
    targetId: 1,
    nodes: [
      { id: "a", type: "start", data: { label: "Start" } },
      {
        id: "b",
        type: "statusChange",
        data: {
          label: `Bad\r\nLabel${PARAGRAPH_SEPARATOR}*/ console.log("pwned"); //`,
          status: "Preparing",
        },
      },
      { id: "c", type: "end", data: { label: "End" } },
    ],
    edges: [
      { source: "a", target: "b" },
      { source: "b", target: "c" },
    ],
  };

  it("keeps every line of the generated comment header prefixed with //", () => {
    const entry = renderEntryScript(evilScenario, { ocppVersion: "1.6" });
    const headerEnd = entry.indexOf("import { check }");
    expect(headerEnd).toBeGreaterThan(-1);
    const header = entry.slice(0, headerEnd);
    const lines = header.split("\n").filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^\/\//);
    }
    // No raw line terminator survived into the comment block.
    expect(header).not.toContain("\r");
    expect(header).not.toContain(LINE_SEPARATOR);
    expect(header).not.toContain(PARAGRAPH_SEPARATOR);
  });

  it("serializes ocppVersion as a proper JSON string literal, not hand-quoted", () => {
    const maliciousVersion = '1.6"); process.exit(1); //';
    const entry = renderEntryScript(scenario, {
      ocppVersion: maliciousVersion,
    });
    expect(entry).toContain(
      `createWire(__ENV.OCPP_VERSION ?? ${JSON.stringify(maliciousVersion)})`,
    );
    // The hand-quoted form (which a bare quote could break out of) is absent.
    expect(entry).not.toContain(
      `createWire(__ENV.OCPP_VERSION ?? "${maliciousVersion}")`,
    );
  });
});

describe("renderReadme", () => {
  const readme = renderReadme({
    scenarioName: "Simple Charge",
    ocppVersion: "1.6",
  });

  it("documents requirements, env vars, and limitations", () => {
    expect(readme).toContain("k6 >= v1.6.0");
    expect(readme).toContain("CSMS_URL");
    expect(readme).toContain("CP_IDS_FILE");
    expect(readme).toContain("PROFILE");
    expect(readme).toMatch(/tlsAuth/);
  });

  it("is a stable artifact (golden)", () => {
    expect(readme).toMatchSnapshot();
  });
});

describe("renderIdsExample", () => {
  it("emits a valid JSON identity array", () => {
    expect(JSON.parse(renderIdsExample())).toEqual([
      { cpId: "CP-0001", basicPassword: "change-me" },
      { cpId: "CP-0002", basicPassword: "change-me" },
    ]);
  });
});
