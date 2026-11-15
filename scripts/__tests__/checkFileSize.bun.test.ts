import { describe, expect, it } from "bun:test";

import {
  ALLOWLIST_PATH,
  MAX_LINES,
  countLines,
  evaluate,
  isCappedSource,
  serialize,
  update,
} from "../check-file-size";
import { readFileSync } from "node:fs";

const sizes: Record<string, number> = {
  "a.ts": 1000,
  "b.ts": 900,
  "c.ts": 700,
};
const lines = (f: string) => sizes[f] ?? null;

describe("countLines", () => {
  it("counts newline characters like wc -l", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\nb")).toBe(1);
  });
});

describe("evaluate", () => {
  it("accepts entries equal to the actual size", () => {
    expect(evaluate({ "a.ts": 1000, "b.ts": 900 }, lines)).toEqual({
      problems: [],
      warnings: [],
    });
  });

  it("fails on a missing file", () => {
    expect(evaluate({ "gone.ts": 900 }, lines).problems).toHaveLength(1);
  });

  it("warns, without failing, on an entry larger than the file", () => {
    const r = evaluate({ "a.ts": 1200 }, lines);
    expect(r.problems).toEqual([]);
    expect(r.warnings).toEqual([
      "slack: a.ts entry 1200 > actual 1000; run --update to tighten",
    ]);
  });

  it("warns, without failing, on an entry for a file within the cap", () => {
    const r = evaluate({ "c.ts": 900 }, lines);
    expect(r.problems).toEqual([]);
    expect(r.warnings).toEqual([
      "slack: c.ts entry 900 > actual 700; run --update to tighten",
    ]);
  });

  it("fails on a file larger than its entry", () => {
    expect(evaluate({ "a.ts": 900 }, lines).problems).toHaveLength(1);
  });

  it("fails on a file over the cap with no entry", () => {
    const r = evaluate({}, lines, ["a.ts", "c.ts"]);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain("a.ts");
  });
});

describe("isCappedSource", () => {
  it("matches the ESLint scope", () => {
    expect(isCappedSource("packages/core/src/x.ts")).toBe(true);
    expect(isCappedSource("packages/core/src/__tests__/x.ts")).toBe(false);
    expect(isCappedSource("apps/web/src/x.test.tsx")).toBe(false);
    expect(isCappedSource("packages/ocpp/src/x.ts")).toBe(false);
    expect(isCappedSource("scripts/x.ts")).toBe(false);
  });
});

describe("update", () => {
  it("lowers entries, drops missing and small files, never raises", () => {
    const next = update(
      { "a.ts": 1200, "b.ts": 850, "c.ts": 700, "gone.ts": 900 },
      lines,
    );
    expect(next).toEqual({ "a.ts": 1000, "b.ts": 850 });
  });

  it("serializes sorted, one entry per line", () => {
    expect(serialize({ "b.ts": 2, "a.ts": 1 })).toBe(
      '{\n  "a.ts": 1,\n  "b.ts": 2\n}\n',
    );
  });
});

describe("file-size-allowlist.json", () => {
  it("is sorted and every entry is above the cap", () => {
    const list = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")) as Record<
      string,
      number
    >;
    const keys = Object.keys(list);
    expect(keys).toEqual([...keys].sort());
    for (const v of Object.values(list)) expect(v).toBeGreaterThan(MAX_LINES);
  });
});
