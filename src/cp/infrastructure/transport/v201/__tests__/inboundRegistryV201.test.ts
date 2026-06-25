import { describe, expect, it } from "vitest";
import { buildV201InboundRegistry } from "../inboundRegistryV201";

describe("buildV201InboundRegistry", () => {
  it("registers supported inbound CSMS CALL actions", () => {
    const registry = buildV201InboundRegistry();

    expect([...registry.keys()]).toEqual([
      "GetVariables",
      "SetVariables",
      "GetBaseReport",
    ]);
    expect(registry.has("Reset")).toBe(false);
  });
});
