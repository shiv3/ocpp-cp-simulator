import { describe, expect, it } from "vitest";
import type { ScenarioDefinition } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import { renderReadme, renderScript, sanitizeForComment } from "../emit/render";

const scenario = {
  id: "s1",
  name: "Evil\nname",
  nodes: [
    {
      id: "a",
      type: "start",
      position: { x: 0, y: 0 },
      data: { label: "Start" },
    },
    {
      id: "b",
      type: "delay",
      position: { x: 0, y: 0 },
      data: { label: "Wait\nhere" },
    },
    { id: "c", type: "end", position: { x: 0, y: 0 }, data: { label: "End" } },
  ],
  edges: [
    { id: "e1", source: "a", target: "b" },
    { id: "e2", source: "b", target: "c" },
  ],
} as unknown as ScenarioDefinition;

describe("renderScript", () => {
  it("wires the engine, the scenario and the metrics", () => {
    const js = renderScript({
      scenario,
      behaviorFiles: [],
      connectors: 2,
      chargersPerVu: 50,
      ocppVersion: "1.6",
    });
    expect(js).toContain(
      'import { k6Options, readFleetConfig, runVu } from "./engine.js";',
    );
    expect(js).toContain('JSON.parse(open("./scenario.json"))');
    expect(js).toContain('CHARGERS_PER_VU: "50"');
    expect(js).toContain("connectors: 2");
    expect(js).toContain("k6Options(config, true)");
    for (const m of [
      "ocpp_call_duration",
      "ocpp_calls",
      "ocpp_errors",
      "ocpp_boot_time",
      "ocpp_scenario_cycles",
      "scenario_success",
    ]) {
      expect(js).toContain(`"${m}"`);
    }
  });

  it("keeps a scenario name on one comment line", () => {
    const js = renderScript({
      scenario,
      behaviorFiles: [],
      connectors: 1,
      chargersPerVu: 50,
      ocppVersion: "1.6",
    });
    expect(js).toContain("// Scenario: Evil name (s1)");
    expect(js).toContain("1. Wait here (delay)");
    expect(sanitizeForComment("a b\r\nc")).toBe("a b  c");
  });

  it("imports every behavior bundle statically", () => {
    const js = renderScript({
      behaviorFiles: ["01-a.bundle.js", "02-b.bundle.js"],
      connectors: 1,
      chargersPerVu: 20,
      ocppVersion: "1.6",
    });
    expect(js).toContain('import behavior0 from "./behaviors/01-a.bundle.js";');
    expect(js).toContain('import behavior1 from "./behaviors/02-b.bundle.js";');
    expect(js).toContain("[].concat(behavior0, behavior1)");
    expect(js).toContain("const scenario = undefined;");
    expect(js).toContain("k6Options(config, false)");
  });
});

describe("renderReadme", () => {
  it("documents the environment and the distributed runs", () => {
    const md = renderReadme({
      title: "T",
      hasScenario: true,
      behaviorFiles: [],
      chargersPerVu: 50,
    });
    expect(md).toContain("`CHARGERS_PER_VU` | `50`");
    expect(md).toContain("--execution-segment");
  });
});
