import { describe, expect, it } from "vitest";
import {
  collectBehaviorParams,
  parseBehaviorParamsFlag,
} from "../behavior/paramsFlag";

describe("--behavior-params", () => {
  it("takes inline JSON", () => {
    expect(
      parseBehaviorParamsFlag(
        'default.firmware={"stepMs":500,"failAt":"none"}',
      ),
    ).toEqual({
      id: "default.firmware",
      params: { stepMs: 500, failAt: "none" },
    });
  });

  it("takes a JSON file", () => {
    const reads: string[] = [];
    const out = parseBehaviorParamsFlag("knob=./knob.json", (path) => {
      reads.push(path);
      return '{"count": 3}';
    });
    expect(reads).toEqual(["./knob.json"]);
    expect(out).toEqual({ id: "knob", params: { count: 3 } });
  });

  it("refuses what is not a <id>=<object>", () => {
    for (const spec of ["", "=x", "default.firmware=", "no-equals"]) {
      expect(() => parseBehaviorParamsFlag(spec)).toThrow("expects <id>=");
    }
    expect(() => parseBehaviorParamsFlag("x={bad")).toThrow("not valid JSON");
    expect(() => parseBehaviorParamsFlag("x=[1]", () => "[1]")).toThrow(
      "must be a JSON object",
    );
    expect(() =>
      parseBehaviorParamsFlag("x=missing.json", () => {
        throw new Error("ENOENT");
      }),
    ).toThrow("cannot read");
  });

  it("refuses a value that is not JSON data and a repeated id", () => {
    expect(() => parseBehaviorParamsFlag('x={"__proto__":{"a":1}}')).toThrow(
      "__proto__",
    );
    expect(() => collectBehaviorParams(['a={"n":1}', 'a={"n":2}'])).toThrow(
      "given twice",
    );
    expect(collectBehaviorParams(['a={"n":1}', 'b={"n":2}'])).toEqual({
      a: { n: 1 },
      b: { n: 2 },
    });
  });
});
