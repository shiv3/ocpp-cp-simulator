// src/cli/exportK6/__tests__/render.test.ts
import { describe, expect, it } from "vitest";
import {
  renderEntryScript,
  renderIdsExample,
  renderReadme,
} from "../emit/render";
import type { ScenarioJson } from "../runtime/types";

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

  it("is a stable artifact (golden)", () => {
    expect(entry).toMatchSnapshot();
  });
});

describe("renderReadme", () => {
  const readme = renderReadme({
    scenarioName: "Simple Charge",
    ocppVersion: "1.6",
  });

  it("documents requirements, env vars, and limitations", () => {
    expect(readme).toContain("k6 >= v1.0");
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
