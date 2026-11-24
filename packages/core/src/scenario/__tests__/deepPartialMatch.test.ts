import { describe, expect, it } from "vitest";
import { deepPartialMatch } from "../deepPartialMatch";

/** Vectors that pin the semantics of the assertion payload match. */
const VECTORS: Array<{
  name: string;
  subset: unknown;
  actual: unknown;
  expected: boolean;
}> = [
  { name: "identical primitives", subset: 1, actual: 1, expected: true },
  { name: "different primitives", subset: 1, actual: 2, expected: false },
  { name: "primitive vs object", subset: 1, actual: { a: 1 }, expected: false },
  {
    name: "subset object",
    subset: { a: 1 },
    actual: { a: 1, b: 2 },
    expected: true,
  },
  {
    name: "missing key",
    subset: { a: 1, c: 3 },
    actual: { a: 1, b: 2 },
    expected: false,
  },
  {
    name: "nested subset",
    subset: { a: { b: 2 } },
    actual: { a: { b: 2, c: 3 } },
    expected: true,
  },
  {
    name: "nested mismatch",
    subset: { a: { b: 9 } },
    actual: { a: { b: 2 } },
    expected: false,
  },
  { name: "array exact match", subset: [1, 2], actual: [1, 2], expected: true },
  {
    name: "array length mismatch (no prefix match)",
    subset: [1],
    actual: [1, 2],
    expected: false,
  },
  {
    name: "array element subset",
    subset: [{ a: 1 }],
    actual: [{ a: 1, b: 2 }],
    expected: true,
  },
  { name: "array vs object", subset: [1], actual: { 0: 1 }, expected: false },
  { name: "object vs array", subset: { a: 1 }, actual: [1], expected: false },
  { name: "null equals null", subset: null, actual: null, expected: true },
  { name: "null vs object", subset: null, actual: {}, expected: false },
  {
    name: "empty subset matches anything object",
    subset: {},
    actual: { x: 1 },
    expected: true,
  },
];

describe("deepPartialMatch", () => {
  for (const v of VECTORS) {
    it(v.name, () => {
      expect(deepPartialMatch(v.subset, v.actual)).toBe(v.expected);
    });
  }
});
