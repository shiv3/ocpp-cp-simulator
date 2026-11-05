import { describe, expect, it } from "bun:test";

import {
  DEFAULT_CONFIG,
  PACKAGE_MAP,
  REPO_ROOT,
  checkBoundaries,
  extractImports,
  hasFailures,
  loadConfig,
  loadSnapshot,
  readAliases,
  validatePackageMap,
  type Snapshot,
} from "../check-package-boundaries";

function snapshot(
  files: Record<string, string>,
  others: string[] = [],
): Snapshot {
  return {
    sources: new Map(Object.entries(files)),
    others: new Set(others),
  };
}

describe("package boundaries of the real tree (#578)", () => {
  const report = checkBoundaries(
    loadSnapshot(REPO_ROOT),
    loadConfig(REPO_ROOT),
  );

  it("has no violation, unmapped file, unresolvable import or stale allow-list entry", () => {
    expect({
      violations: report.violations.map((v) => v.message),
      unmapped: report.unmapped,
      unresolved: report.unresolved,
      stale: report.staleAllowances,
    }).toEqual({ violations: [], unmapped: [], unresolved: [], stale: [] });
    expect(hasFailures(report)).toBe(false);
  });

  it("checked a plausible number of files and imports", () => {
    expect(report.edges.length).toBeGreaterThan(1000);
    for (const n of Object.values(report.fileCounts))
      expect(n).toBeGreaterThan(0);
  });

  it("reads the @/ alias from tsconfig.app.json", () => {
    expect(loadConfig(REPO_ROOT).aliases).toEqual({ "@/": "src/" });
  });
});

describe("package boundaries on synthetic input", () => {
  it("catches a forbidden edge", () => {
    const r = checkBoundaries(
      snapshot({
        "packages/contracts/src/a.ts":
          'import { x } from "../cp/b";\nexport const y = x;',
        "packages/core/src/cp/b.ts": "export const x = 1;",
      }),
    );
    expect(r.violations.map((v) => [v.group, v.file, v.target])).toEqual([
      ["contracts → core", "packages/contracts/src/a.ts", "packages/core/src/cp/b.ts"],
    ]);
    expect(hasFailures(r)).toBe(true);
  });

  it("catches a type-only forbidden edge, in every spelling", () => {
    const r = checkBoundaries(
      snapshot({
        "packages/client/src/interfaces/a.ts": [
          'import type { A } from "../../store/s";',
          'import { type B } from "../../store/s";',
          'export type { C } from "../../store/s";',
          'export type D = import("../../store/s").D;',
          'export const e = () => import("../../store/s");',
        ].join("\n"),
        "apps/web/src/store/s.ts": "export type A = 1, B = 1, C = 1, D = 1;",
      }),
    );
    expect(r.violations.map((v) => v.typeOnly)).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(new Set(r.violations.map((v) => v.group))).toEqual(
      new Set(["client → apps/web"]),
    );
  });

  it("resolves the @/ alias and new URL(..., import.meta.url)", () => {
    const r = checkBoundaries(
      snapshot({
        "packages/trace/src/a.ts": [
          'import { x } from "@/cp/b";',
          'export const u = new URL("../cp/b.ts", import.meta.url);',
        ].join("\n"),
        "packages/core/src/cp/b.ts": "export const x = 1;",
      }),
    );
    expect(r.violations).toHaveLength(2);
    expect(r.violations.map((v) => v.group)).toEqual([
      "trace → core",
      "trace → core",
    ]);
  });

  it("catches a forbidden specifier in a portable package, not in a test or an app", () => {
    const r = checkBoundaries(
      snapshot({
        "packages/core/src/cp/a.ts":
          'import { useState } from "react";\nimport fs from "node:fs";',
        "packages/core/src/cp/a.test.ts": 'import fs from "node:fs";',
        "apps/cli/src/a.ts": 'import fs from "node:fs";',
        "apps/web/src/components/a.tsx": 'import { useState } from "react";',
        "packages/core/src/cp/types.ts": 'import type { Node } from "@xyflow/react";',
      }),
    );
    expect(r.violations.map((v) => [v.group, v.file])).toEqual([
      ["core ⊅ react", "packages/core/src/cp/a.ts"],
      ["core ⊅ node", "packages/core/src/cp/a.ts"],
    ]);
    expect(r.typeOnlyForbidden.map((t) => t.file)).toEqual(["packages/core/src/cp/types.ts"]);
  });

  it("honours the specifier allow-list and flags stale entries", () => {
    const config = {
      ...DEFAULT_CONFIG,
      testAllowList: [],
      specifierAllowList: {
        "packages/core/src/cp/a.ts": { specifiers: ["bun:sqlite", "bun:ffi"], why: "test" },
      },
    };
    const r = checkBoundaries(
      snapshot({ "packages/core/src/cp/a.ts": 'import { Database } from "bun:sqlite";' }),
      config,
    );
    expect(r.violations).toEqual([]);
    expect(r.staleAllowances).toEqual([
      'SPECIFIER_ALLOW_LIST packages/core/src/cp/a.ts "bun:ffi"',
    ]);
  });

  it("fails on a file that matches no map entry and on an unresolvable import", () => {
    const r = checkBoundaries(
      snapshot({ "src/newdir/a.ts": 'import "./missing";' }),
    );
    expect(r.unmapped).toEqual(["src/newdir/a.ts"]);
    const r2 = checkBoundaries(
      snapshot({ "packages/core/src/cp/a.ts": 'import "./missing";' }),
    );
    expect(r2.unresolved).toEqual([
      { file: "packages/core/src/cp/a.ts", specifier: "./missing" },
    ]);
  });

  it("rejects a map whose broad entry shadows a specific one", () => {
    expect(() =>
      validatePackageMap([
        { match: "apps/cli/src/", pkg: "apps/cli" },
        { match: "packages/k6-runtime/src/", pkg: "k6-runtime" },
      ]),
    ).toThrow(/shadowed/);
    expect(() => validatePackageMap(PACKAGE_MAP)).not.toThrow();
  });
});

describe("extractImports", () => {
  it("finds every import form", () => {
    const kinds = extractImports(
      "src/x.ts",
      [
        'import a from "a";',
        'import "b";',
        'import type { C } from "c";',
        'export * from "d";',
        'export { e } from "e";',
        'await import("f");',
        'import g = require("g");',
      ].join("\n"),
    ).map((i) => [i.specifier, i.kind]);
    expect(kinds).toEqual([
      ["a", "import"],
      ["b", "side-effect"],
      ["c", "import-type"],
      ["d", "export-from"],
      ["e", "export-from"],
      ["f", "dynamic"],
      ["g", "require"],
    ]);
  });

  it("parses the alias out of a commented tsconfig", () => {
    expect(
      readAliases(
        '{ /* c */ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
      ),
    ).toEqual({ "@/": "src/" });
  });
});
