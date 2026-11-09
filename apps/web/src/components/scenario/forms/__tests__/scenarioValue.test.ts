import { describe, expect, it } from "vitest";

import { ScenarioNodeType } from "@ocpp-cp-simulator/core/cp/application/scenario/ScenarioTypes";
import {
  collectStateKeys,
  convertConstant,
  fromValue,
  jsonEqual,
  moveItem,
  pathAdvice,
  readValueShape,
  removeItem,
} from "../scenarioValue";

describe("readValueShape", () => {
  it.each([
    ["text", "Charging"],
    ["text", ""],
    ["number", 3],
    ["number", -1.5],
    ["boolean", true],
    ["boolean", false],
    ["null", null],
    ["json", [1, "a"]],
    ["json", { a: 1 }],
  ] as const)("reads %s constants (%j)", (type, value) => {
    expect(readValueShape(value)).toEqual({ mode: "constant", type });
  });

  it.each([
    ["call", "payload.requestId"],
    ["call", "action"],
    ["call", ""],
    ["charger", "ocppVersion"],
    ["connector", "power.acceptedW"],
    ["state", "mode"],
    ["state", "nested.key"],
  ] as const)("reads $from on %s.%s and writes it back", (root, path) => {
    const value = fromValue(root, path);
    const shape = readValueShape(value);
    expect(shape).toEqual({ mode: "from", root, path });
    if (shape.mode !== "from") throw new Error("unreachable");
    expect(fromValue(shape.root, shape.path)).toEqual(value);
  });

  it.each([
    ["an unknown root", { $from: "station.id" }],
    ["a trailing dot", { $from: "call." }],
    ["a second key", { $from: "state.x", other: 1 }],
    ["a non-string $from", { $from: 5 }],
  ])("shows %s as JSON (nothing lost)", (_, value) => {
    expect(readValueShape(value)).toEqual({ mode: "constant", type: "json" });
  });

  it("reads a $from as JSON where only constants belong", () => {
    expect(readValueShape({ $from: "state.x" }, false)).toEqual({
      mode: "constant",
      type: "json",
    });
  });

  it("reads undefined as unset", () => {
    expect(readValueShape(undefined)).toEqual({ mode: "unset" });
  });
});

describe("convertConstant", () => {
  it("keeps a value already of the type, else the nearest one", () => {
    expect(convertConstant("x", "text")).toBe("x");
    expect(convertConstant(12, "text")).toBe("12");
    expect(convertConstant("12", "number")).toBe(12);
    expect(convertConstant("abc", "number")).toBe(0);
    expect(convertConstant("false", "boolean")).toBe(false);
    expect(convertConstant(1, "null")).toBeNull();
    const object = { a: [1] };
    expect(convertConstant(object, "json")).toBe(object);
  });
});

describe("pathAdvice", () => {
  it("is quiet on the fixed fields and known state keys", () => {
    expect(pathAdvice("connector", "status", [])).toBeNull();
    expect(pathAdvice("call", "payload.requestId", [])).toBeNull();
    expect(pathAdvice("state", "mode.sub", ["mode"])).toBeNull();
  });
  it("notes an incomplete path, an unknown field, an unknown key", () => {
    expect(pathAdvice("call", "payload.", [])).toBe("incomplete");
    expect(pathAdvice("charger", "", [])).toBe("incomplete");
    expect(pathAdvice("connector", "speed", [])).toBe("unknownField");
    expect(pathAdvice("state", "other", ["mode"])).toBe("unknownStateKey");
  });
});

describe("collectStateKeys", () => {
  it("lists setState keys once each, in file order", () => {
    const step = (type: ScenarioNodeType, key?: string) => ({
      type,
      data: { label: "", key },
    });
    expect(
      collectStateKeys([
        step(ScenarioNodeType.SET_STATE, "b"),
        step(ScenarioNodeType.DELAY, "x"),
        step(ScenarioNodeType.SET_STATE, "a"),
        step(ScenarioNodeType.SET_STATE, "b"),
        step(ScenarioNodeType.SET_STATE, ""),
      ]),
    ).toEqual(["b", "a"]);
  });
});

describe("list edits", () => {
  it("maps each old index to its new place", () => {
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual({
      next: ["c", "a", "b"],
      mapping: [1, 2, 0],
    });
    expect(removeItem(["a", "b", "c"], 1)).toEqual({
      next: ["a", "c"],
      mapping: [0, null, 1],
    });
  });

  it("compares as JSON (key order does not matter, types do)", () => {
    expect(jsonEqual({ a: 1, b: [2] }, { b: [2], a: 1 })).toBe(true);
    expect(jsonEqual(1, "1")).toBe(false);
  });
});
