import { describe, expect, it } from "vitest";
import { deepPartialMatch } from "../deepPartialMatch";
import { deepPartialMatch as k6DeepPartialMatch } from "../../cli/exportK6/runtime/assertions";

/** Shared vectors run against BOTH implementations: the k6 runtime cannot
 *  import repo modules (purity gate), so its copy stays — this table is
 *  what keeps the two from drifting. */
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

describe("deepPartialMatch (canonical + k6 runtime copy)", () => {
  for (const impl of [
    { label: "src/scenario", fn: deepPartialMatch },
    { label: "exportK6 runtime", fn: k6DeepPartialMatch },
  ]) {
    for (const v of VECTORS) {
      it(`${impl.label}: ${v.name}`, () => {
        expect(impl.fn(v.subset, v.actual)).toBe(v.expected);
      });
    }
  }
});
