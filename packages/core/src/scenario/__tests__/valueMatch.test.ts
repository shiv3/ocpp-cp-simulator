import { describe, expect, it } from "vitest";

import {
  MISSING,
  MatcherError,
  describeMatcher,
  isMatcher,
  jsonEquals,
  matchCase,
  matcherProblem,
  matchesEveryPresentValue,
} from "../valueMatch";

const m = (body: unknown) => ({ $match: body });

describe("isMatcher", () => {
  it("is an object whose only key is $match", () => {
    expect(isMatcher(m({ equals: 1 }))).toBe(true);
    expect(isMatcher({ $match: { equals: 1 }, other: 1 })).toBe(false);
    expect(isMatcher({ x: 1 })).toBe(false);
    expect(isMatcher(null)).toBe(false);
    expect(isMatcher([m({})])).toBe(false);
  });
});

describe("matchCase: constants", () => {
  it("compares by strict JSON equality, as switch did in 1.6", () => {
    expect(matchCase("Accepted", "Accepted")).toBe(true);
    expect(matchCase(1, "1")).toBe(false);
    expect(matchCase({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(matchCase(null, null)).toBe(true);
  });

  it("an object with $match beside other keys is a constant", () => {
    const constant = { $match: { gte: 1 }, x: 1 };
    expect(matchCase(constant, constant)).toBe(true);
    expect(matchCase(5, constant)).toBe(false);
  });

  it("a missing value matches no constant", () => {
    expect(matchCase(MISSING, null)).toBe(false);
    expect(matchCase(MISSING, "x")).toBe(false);
  });
});

describe("matchCase: operators", () => {
  it("equals and in are strict JSON equality", () => {
    expect(matchCase("30", m({ equals: "30" }))).toBe(true);
    expect(matchCase(30, m({ equals: "30" }))).toBe(false);
    expect(matchCase({ a: 1 }, m({ equals: { a: 1 } }))).toBe(true);
    expect(matchCase("Blocked", m({ in: ["Blocked", "Invalid"] }))).toBe(true);
    expect(matchCase("Accepted", m({ in: ["Blocked", "Invalid"] }))).toBe(
      false,
    );
    expect(matchCase(1, m({ in: ["1"] }))).toBe(false);
  });

  it("orders numbers numerically", () => {
    expect(matchCase(80, m({ gte: 80 }))).toBe(true);
    expect(matchCase(79.9, m({ gte: 80 }))).toBe(false);
    expect(matchCase(9, m({ gt: 10 }))).toBe(false);
    expect(matchCase(9, m({ lt: 10 }))).toBe(true);
    expect(matchCase(10, m({ lte: 10 }))).toBe(true);
  });

  it("orders strings lexicographically (ISO-8601 instants)", () => {
    expect(
      matchCase("2026-11-09T10:00:00Z", m({ gt: "2026-11-09T09:00:00Z" })),
    ).toBe(true);
    expect(matchCase("b", m({ lt: "a" }))).toBe(false);
    expect(matchCase("Charging", m({ gte: "Available" }))).toBe(true);
  });

  it("compares a canonical decimal string as a number", () => {
    // OCPP 1.6 carries Configuration values as strings.
    expect(matchCase("60", m({ gte: 60 }))).toBe(true);
    expect(matchCase("9", m({ gt: 10 }))).toBe(false); // not "9" > "10" lexically
    expect(matchCase("100", m({ gt: "20" }))).toBe(true); // both as numbers
    expect(matchCase(100, m({ gt: "20" }))).toBe(true);
    expect(matchCase("-1.5", m({ lt: 0 }))).toBe(true);
    // equals stays strict.
    expect(matchCase("60", m({ equals: 60 }))).toBe(false);
  });

  it("does not convert anything that is not a canonical decimal", () => {
    expect(matchCase("060", m({ gte: 1 }))).toBe(false);
    expect(matchCase("1e3", m({ gte: 1 }))).toBe(false);
    expect(matchCase(" 5", m({ gte: 1 }))).toBe(false);
    expect(matchCase("abc", m({ gt: 5 }))).toBe(false);
    expect(matchCase(true, m({ gte: 0 }))).toBe(false);
    expect(matchCase(null, m({ lte: 0 }))).toBe(false);
    expect(matchCase({}, m({ gt: 0 }))).toBe(false);
  });

  it("exists: true for any present value (null included), false for missing", () => {
    expect(matchCase(null, m({ exists: true }))).toBe(true);
    expect(matchCase(0, m({ exists: true }))).toBe(true);
    expect(matchCase("x", m({ exists: false }))).toBe(false);
    expect(matchCase(MISSING, m({ exists: false }))).toBe(true);
    expect(matchCase(MISSING, m({ exists: true }))).toBe(false);
  });

  it("startsWith, endsWith and includes need a string value", () => {
    expect(matchCase("Vendor.FreeVend", m({ startsWith: "Vendor." }))).toBe(
      true,
    );
    expect(matchCase("abc", m({ endsWith: "bc" }))).toBe(true);
    expect(matchCase("abc", m({ includes: "x" }))).toBe(false);
    expect(matchCase(123, m({ startsWith: "1" }))).toBe(false);
    expect(matchCase(["a"], m({ includes: "a" }))).toBe(false);
  });

  it("not negates one level", () => {
    expect(matchCase("Available", m({ not: { equals: "Charging" } }))).toBe(
      true,
    );
    expect(matchCase("Charging", m({ not: { equals: "Charging" } }))).toBe(
      false,
    );
    expect(matchCase(5, m({ not: { gte: 10, lt: 20 } }))).toBe(true);
    expect(matchCase(15, m({ not: { gte: 10, lt: 20 } }))).toBe(false);
    expect(matchCase("x", m({ not: { exists: false } }))).toBe(true);
  });

  it("ANDs the operators of one $match", () => {
    const band = m({ gte: 20, lt: 80 });
    expect(matchCase(20, band)).toBe(true);
    expect(matchCase(79, band)).toBe(true);
    expect(matchCase(80, band)).toBe(false);
    expect(matchCase(19, band)).toBe(false);
    expect(matchCase("50", band)).toBe(true);
  });
});

describe("matchCase: a missing value", () => {
  it("matches only { exists: false } exactly", () => {
    expect(matchCase(MISSING, m({ exists: false }))).toBe(true);
    expect(matchCase(MISSING, m({ exists: false, equals: 1 }))).toBe(false);
    expect(matchCase(MISSING, m({ not: { equals: 1 } }))).toBe(false);
    expect(matchCase(MISSING, m({ not: { exists: true } }))).toBe(false);
    expect(matchCase(MISSING, m({ gte: 0 }))).toBe(false);
    expect(matchCase(MISSING, m({ in: [] }))).toBe(false);
  });
});

describe("matchCase: unusable matchers throw", () => {
  const kind = (spec: unknown) => {
    try {
      matchCase(1, spec);
    } catch (e) {
      expect(e).toBeInstanceOf(MatcherError);
      return (e as MatcherError).kind;
    }
    return null;
  };

  it("an unknown operator is unknownMatcher", () => {
    expect(kind(m({ regex: "a" }))).toBe("unknownMatcher");
    expect(kind(m({ equals: 1, anyOf: [] }))).toBe("unknownMatcher");
    expect(kind(m({ not: { regex: "a" } }))).toBe("unknownMatcher");
  });

  it("a wrongly typed argument is badMatcherArgument", () => {
    expect(kind(m({ in: "Blocked" }))).toBe("badMatcherArgument");
    expect(kind(m({ gte: true }))).toBe("badMatcherArgument");
    expect(kind(m({ gte: null }))).toBe("badMatcherArgument");
    expect(kind(m({ exists: "yes" }))).toBe("badMatcherArgument");
    expect(kind(m({ startsWith: 1 }))).toBe("badMatcherArgument");
    expect(kind(m({ not: "x" }))).toBe("badMatcherArgument");
    expect(kind(m({ not: { not: { equals: 1 } } }))).toBe("badMatcherArgument");
  });

  it("an empty or non-object $match is badMatcherArgument", () => {
    expect(kind(m({}))).toBe("badMatcherArgument");
    expect(kind(m([]))).toBe("badMatcherArgument");
    expect(kind(m(null))).toBe("badMatcherArgument");
    expect(kind(m("in"))).toBe("badMatcherArgument");
  });

  it("matcherProblem reports without throwing and ignores constants", () => {
    expect(matcherProblem(m({ gte: 1 }))).toBeNull();
    expect(matcherProblem("x")).toBeNull();
    expect(matcherProblem({ $match: {}, x: 1 })).toBeNull();
    expect(matcherProblem(m({ regex: "a" }))).toMatchObject({
      kind: "unknownMatcher",
      operator: "regex",
    });
  });
});

describe("describeMatcher", () => {
  it("writes short chip texts", () => {
    expect(describeMatcher(m({ in: ["Blocked", "Invalid", "Expired"] }))).toBe(
      "in Blocked|Invalid|Expired",
    );
    expect(describeMatcher(m({ gte: 80 }))).toBe("≥ 80");
    expect(describeMatcher(m({ exists: false }))).toBe("missing");
    expect(describeMatcher(m({ gte: 20, lt: 80 }))).toBe("≥ 20, < 80");
    expect(describeMatcher(m({ not: { equals: "Charging" } }))).toBe(
      "not (= Charging)",
    );
    expect(describeMatcher(m({ startsWith: "Vendor." }))).toBe(
      "starts with Vendor.",
    );
  });

  it("never throws on a broken matcher", () => {
    expect(() => describeMatcher(m(null))).not.toThrow();
    expect(describeMatcher(m({}))).toBe("match ?");
    expect(describeMatcher(m({ in: 5 }))).toBe("in ?");
  });
});

describe("matchesEveryPresentValue", () => {
  it("is exists:true and not exists:false only", () => {
    expect(matchesEveryPresentValue(m({ exists: true }))).toBe(true);
    expect(matchesEveryPresentValue(m({ not: { exists: false } }))).toBe(true);
    expect(matchesEveryPresentValue(m({ exists: false }))).toBe(false);
    expect(matchesEveryPresentValue(m({ exists: true, gte: 1 }))).toBe(false);
    expect(matchesEveryPresentValue("x")).toBe(false);
  });
});

describe("jsonEquals", () => {
  it("ignores key order but not types", () => {
    expect(jsonEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(jsonEquals([1, 2], [2, 1])).toBe(false);
    expect(jsonEquals(1, "1")).toBe(false);
  });
});
