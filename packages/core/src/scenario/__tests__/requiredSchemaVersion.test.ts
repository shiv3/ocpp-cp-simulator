import { describe, expect, it } from "vitest";
import { requiredSchemaVersion } from "../scenarioGraphValidator";

const nodes = [
  { id: "start", type: "start", data: {} },
  { id: "m", type: "delay", data: { delaySeconds: 1 } },
  { id: "end", type: "end", data: {} },
] as never;
const plain = [
  { id: "e1", source: "start", target: "m" },
  { id: "e2", source: "m", target: "end" },
] as never[];
const loop = {
  id: "l",
  source: "m",
  target: "m",
  kind: "loop",
  loop: { times: 2 },
} as never;

describe("requiredSchemaVersion", () => {
  it("raises an older declaration to the version of a loop edge", () => {
    expect(
      requiredSchemaVersion({
        nodes,
        edges: [...plain, loop],
        schemaVersion: "1.5",
      }),
    ).toBe("1.10");
  });
  it("never lowers a newer declaration", () => {
    expect(
      requiredSchemaVersion({
        nodes,
        edges: [...plain, loop],
        schemaVersion: "1.12",
      }),
    ).toBe("1.12");
  });
  it("leaves a scenario without such a construct, or without a version, alone", () => {
    expect(
      requiredSchemaVersion({ nodes, edges: plain, schemaVersion: "1.2" }),
    ).toBe("1.2");
    expect(requiredSchemaVersion({ nodes, edges: [...plain, loop] })).toBe(
      undefined,
    );
  });
});
