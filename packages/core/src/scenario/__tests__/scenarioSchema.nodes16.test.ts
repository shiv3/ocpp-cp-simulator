import { describe, expect, it } from "vitest";
import { validateScenarioSchema } from "../scenarioSchemaValidator";

// Schema 1.6, step 3 of #654: the new nodes and fields validate, and the
// closed vocabularies reject what the executor would refuse.

const base = (nodes: unknown[], edges: unknown[] = []) => ({
  schemaVersion: "1.6",
  id: "s",
  name: "s",
  targetType: "connector",
  targetId: 1,
  nodes: [
    {
      id: "start",
      type: "start",
      position: { x: 0, y: 0 },
      data: { label: "Start" },
    },
    ...nodes,
  ],
  edges,
});
const node = (type: string, data: Record<string, unknown>) => ({
  id: "n",
  type,
  position: { x: 0, y: 0 },
  data: { label: type, ...data },
});

describe("schema 1.6 nodes", () => {
  it.each([
    ["notify", { kind: "firmwareStatus", status: "Installed", requestId: 3 }],
    [
      "notify",
      {
        kind: "logStatus",
        status: "Uploading",
        requestId: { $from: "state.rid" },
      },
    ],
    ["switch", { value: { $from: "connector.status" }, cases: ["Available"] }],
    ["choice", { options: [{ weight: 2, label: "a" }, {}] }],
    ["setState", { key: "k_1", value: { n: [1, 2] } }],
    [
      "delay",
      { delaySeconds: 0, until: "2030-01-01T00:00:00Z", jitterSeconds: 2.5 },
    ],
    ["callResponse", { kind: "accepted" }],
    ["callResponse", { kind: "rejected" }],
    ["callResponse", { kind: "result", payload: { status: "Accepted" } }],
  ])("accepts %s %j", (type, data) => {
    expect(validateScenarioSchema(base([node(type, data)])).errors).toEqual([]);
  });

  it.each([
    ["notify", { kind: "bogus", status: "Installed" }],
    ["notify", { kind: "logStatus" }],
    ["notify", { kind: "logStatus", status: "Uploading", requestId: -1 }],
    [
      "notify",
      { kind: "logStatus", status: "Uploading", requestId: { $from: "env.X" } },
    ],
    ["switch", { value: 1 }],
    ["choice", { options: [{}] }],
    ["choice", { options: [{ weight: 0 }, {}] }],
    ["setState", { key: "a.b", value: 1 }],
    ["setState", { key: "k" }],
    ["delay", { delaySeconds: 1, jitterSeconds: -1 }],
    ["callResponse", { kind: "maybe" }],
    // #846: the executor throws on a payload next to accepted / rejected.
    ["callResponse", { kind: "accepted", payload: { status: "Accepted" } }],
    ["callResponse", { kind: "rejected", payload: {} }],
    ["callResponse", { kind: "accepted", skipValidation: true }],
  ])("rejects %s %j", (type, data) => {
    expect(validateScenarioSchema(base([node(type, data)])).valid).toBe(false);
  });

  it("keeps sourceHandle on edges", () => {
    const result = validateScenarioSchema(
      base(
        [node("switch", { value: 1, cases: [1] })],
        [{ id: "e", source: "n", target: "start", sourceHandle: "case-0" }],
      ),
    );
    expect(result.errors).toEqual([]);
  });
});
