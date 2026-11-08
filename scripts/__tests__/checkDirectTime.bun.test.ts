import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  EXEMPTIONS,
  REPO_ROOT,
  SCANNED_FILES,
  evaluate,
  scanSource,
  scanTree,
  type Exemption,
  type Use,
} from "../check-direct-time";

const kinds = (text: string) => scanSource("x.ts", text).map((u) => u.kind);

describe("scanSource", () => {
  it("finds the direct clock and randomness reads", () => {
    expect(
      kinds(`
        const a = Date.now();
        const b = new Date();
        const c = performance.now();
        const d = Math.random();
        const e = crypto.randomUUID();
        crypto.getRandomValues(new Uint8Array(1));
        setTimeout(f, 1);
        setInterval(f, 1);
        clearTimeout(t);
        clearInterval(t);
        globalThis.setTimeout(f, 1);
        window.clearInterval(t);
      `),
    ).toEqual([
      "Date.now",
      "new Date()",
      "performance.now",
      "Math.random",
      "crypto.randomUUID",
      "crypto.getRandomValues",
      "setTimeout",
      "setInterval",
      "clearTimeout",
      "clearInterval",
      "setTimeout",
      "clearInterval",
    ]);
  });

  it("finds a default parameter that reads the clock", () => {
    expect(kinds("function f(now: Date = new Date()) { return now; }")).toEqual(
      ["new Date()"],
    );
  });

  it("leaves the injected clock, dates built from a value, and comments alone", () => {
    expect(
      kinds(`
        // Date.now() and setTimeout(x) in a comment
        const s = "Math.random()";
        const a = this.clock.setTimeout(f, 1);
        this.clock.clearTimeout(a);
        clock.now();
        const b = new Date(123);
        const c = new Date(clock.now());
        const d = Date.parse("2030-01-01");
        type T = ReturnType<typeof setTimeout>;
      `),
    ).toEqual([]);
  });

  it("reports the line of a use", () => {
    const uses = scanSource("x.ts", "\n\nconst a = Date.now();\n");
    expect(uses).toEqual([{ kind: "Date.now", line: 3 }]);
  });
});

describe("evaluate", () => {
  const use = (kind: Use["kind"], line = 1): Use => ({ kind, line });
  const exemption = (count: number): Exemption => ({
    file: "a.ts",
    kind: "Date.now",
    count,
    reason: "test",
  });

  it("passes when every use is exempted exactly", () => {
    const report = evaluate(new Map([["a.ts", [use("Date.now")]]]), [
      exemption(1),
    ]);
    expect(report.violations).toEqual([]);
    expect(report.stale).toEqual([]);
  });

  it("fails on a use nothing exempts", () => {
    const report = evaluate(new Map([["b.ts", [use("Date.now", 7)]]]), []);
    expect(report.violations).toEqual([
      { file: "b.ts", kind: "Date.now", lines: [7], allowed: 0 },
    ]);
  });

  it("fails on one use more than the exemption allows", () => {
    const report = evaluate(
      new Map([["a.ts", [use("Date.now", 1), use("Date.now", 2)]]]),
      [exemption(1)],
    );
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.lines).toEqual([1, 2]);
  });

  it("fails on a stale exemption, so the list only shrinks", () => {
    const report = evaluate(new Map(), [exemption(2)]);
    expect(report.stale).toEqual([{ exemption: exemption(2), found: 0 }]);
  });
});

describe("the repository", () => {
  it("has no direct clock or randomness beyond the exemption list", () => {
    const report = evaluate(scanTree(), EXEMPTIONS);
    expect(report.violations).toEqual([]);
    expect(report.stale).toEqual([]);
  });

  it("scans the message handlers and finds nothing direct in them", () => {
    expect(SCANNED_FILES.length).toBeGreaterThan(0);
    for (const file of SCANNED_FILES) {
      expect(existsSync(join(REPO_ROOT, file))).toBe(true);
    }
    const scanned = [...scanTree().keys()];
    expect(scanned.filter((f) => SCANNED_FILES.some((s) => s === f))).toEqual(
      [],
    );
  });
});
