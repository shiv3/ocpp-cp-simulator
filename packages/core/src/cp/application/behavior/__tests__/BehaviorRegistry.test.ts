import { describe, expect, it } from "vitest";
import { BehaviorRegistry } from "../BehaviorRegistry";

describe("BehaviorRegistry (stage A stub)", () => {
  it("resolves every call to the default path", () => {
    const registry = new BehaviorRegistry();
    expect(
      registry.resolve({ action: "Reset", payload: { type: "Soft" } }),
    ).toEqual({
      kind: "default",
    });
    expect(
      registry.resolve({
        action: "UnlockConnector",
        payload: {},
        connectorId: 1,
      }),
    ).toEqual({ kind: "default" });
    expect(registry.resolve({ action: "NoSuchAction", payload: null })).toEqual(
      {
        kind: "default",
      },
    );
  });
});
