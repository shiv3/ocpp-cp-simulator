import { describe, expect, it } from "vitest";
import { k6ConstructorArgs } from "../k6Args";

describe("k6ConstructorArgs", () => {
  it("maps Bun-style options to k6's (protocols, params)", () => {
    expect(
      k6ConstructorArgs({
        protocols: ["ocpp1.6"],
        headers: { Authorization: "Basic abc" },
      }),
    ).toEqual({
      protocols: ["ocpp1.6"],
      params: { headers: { Authorization: "Basic abc" } },
    });
  });
  it("accepts a bare protocol string, a protocol list and nothing", () => {
    expect(k6ConstructorArgs("ocpp1.6")).toEqual({
      protocols: ["ocpp1.6"],
      params: undefined,
    });
    expect(k6ConstructorArgs(["a", "b"])).toEqual({
      protocols: ["a", "b"],
      params: undefined,
    });
    expect(k6ConstructorArgs()).toEqual({ protocols: [], params: undefined });
    expect(k6ConstructorArgs({ protocols: "x" })).toEqual({
      protocols: ["x"],
      params: undefined,
    });
  });
});
